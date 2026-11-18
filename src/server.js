import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { config, jiraAuthHeader } from "./config.js";
import { fetchAbertos, fetchFilter, fetchIssuesByJql, normalizeIssue, DEFAULT_FIELDS, fetchIssueDetails, fetchComments, fetchWorklogs, fetchRecentActivity, fetchAttachmentMeta, jqlForScope, fetchProjects, jqlForProject, searchIssues, createComment, getJiraAccountIdByEmail, jiraFetch, searchJiraUsers } from "./jira.js";
import { isPipefyConfigured, fetchPipe, fetchCards, createCardFromIssue, syncIssuesToPipefy } from "./pipefy.js";
import { login, logout, getSessionFromRequest, requireAuth, requireAdmin, requireProjectScope, filterProjectsForSession, requestedProject, issueProjectGuard, createSession } from "./auth.js";
import { verifyGoogleIdToken } from "./googleAuth.js";
import { upsertPendingUser, getUserByEmail, listUsers, approveUser, rejectUser, updateUserScope, isAdminEmail, ADMIN_EMAIL } from "./users.js";
import { syncReleaseNotes, listReleaseNotes, getStatus } from "./release-notes.js";
import { runTwg, readTwgOutput, twgErrorMessage } from "./twg.js";
import { db, initNtpDocumentsDB, updateDocumentMeta, countPending } from "./ntp-documents.js";
import { db as activityDb, initActivityControlDB, listActivities, getActivity, createActivity, updateActivity, deleteActivity, markWhatsappSent, countActivities, getPendingWhatsapp, listActivitiesFiltered } from "./activity-control.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, 'assets', 'logo_az_white.png');
let LOGO_PNG_BYTES = null;
async function getLogoBytes() {
  if (!LOGO_PNG_BYTES) {
    try { LOGO_PNG_BYTES = await fs.promises.readFile(LOGO_PATH); } catch { LOGO_PNG_BYTES = null; }
  }
  return LOGO_PNG_BYTES;
}
const app = express();

// Health check endpoint (usado por scripts de deploy/expose)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", port: process.env.PORT || "3000", timestamp: new Date().toISOString() });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "..", "public")));

// Root route - serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use(express.json());

// CORS simples (API consumida por sistemas externos)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Cache em memoria (TTL 60s)
const cache = new Map();
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function setCached(key, value, ttlMs = 60_000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "jira-tocantins-app", time: new Date().toISOString() });
});

// ===== Autenticacao =====
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Informe usuario e senha." });
  }
  const result = login(String(username), String(password));
  if (!result) {
    return res.status(401).json({ success: false, error: "Usuario ou senha invalidos." });
  }
  res.json({ success: true, ...result });
});

// Valida token salvo no cliente
app.get("/api/me", (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ success: false, error: "Nao autenticado." });
  res.json({ success: true, user: { username: session.username, email: session.email, allowedProjects: session.allowedProjects, isAdmin: !!session.isAdmin }, expiresAt: new Date(session.expires).toISOString() });
});
app.post("/api/logout", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (token) logout(token);
  res.json({ success: true });
});

// ===== Auth Google (dominio azi.com.br) =====
app.get("/api/auth/config", (req, res) => {
  res.json({
    success: true,
    googleEnabled: Boolean(config.google.clientId),
    clientId: config.google.clientId || null,
    allowedDomain: config.google.allowedDomain,
    adminEmail: config.adminEmail,
  });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const credential = req.body?.credential || req.body?.idToken;
    if (!credential) return res.status(400).json({ success: false, error: "Token Google ausente." });
    if (!config.google.clientId) {
      return res.status(503).json({ success: false, error: "Google OAuth nao configurado (GOOGLE_CLIENT_ID)." });
    }
    const payload = await verifyGoogleIdToken(credential, config.google.clientId);
    const email = String(payload.email).toLowerCase();
    const domain = email.split("@")[1] || "";
    if (domain !== config.google.allowedDomain) {
      return res.status(403).json({ success: false, error: `Acesso restrito ao dominio @${config.google.allowedDomain}.` });
    }

    const user = upsertPendingUser({
      email,
      name: payload.name || payload.given_name || email,
      picture: payload.picture || null,
    });

    if (user.status === "pending") {
      return res.status(202).json({ success: true, status: "pending", message: "Cadastro pendente de aprovacao pelo administrador.", user: { email: user.email, name: user.name } });
    }
    if (user.status === "rejected") {
      return res.status(403).json({ success: false, error: "Cadastro rejeitado pelo administrador." });
    }
    // approved
    const session = createSession({
      username: user.email,
      email: user.email,
      allowedProjects: user.allowedProjects && user.allowedProjects.length ? user.allowedProjects : (user.isAdmin ? ["all"] : []),
      isAdmin: user.isAdmin,
    });
    res.json({ success: true, status: "approved", ...session });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message || "Falha na autenticacao Google." });
  }
});

// ===== Administracao de usuarios (admin) =====
app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = listUsers();
  res.json({ success: true, count: users.length, data: users });
});

app.post("/api/admin/users/:id/approve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "id invalido" });
  const scope = req.body?.allowedProjects || req.body?.scope;
  let projects = ["all"];
  if (Array.isArray(scope)) projects = scope;
  else if (typeof scope === "string" && scope.trim()) {
    projects = scope.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const user = approveUser(id, projects, req.session.email);
  res.json({ success: true, data: user });
});

app.post("/api/admin/users/:id/reject", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "id invalido" });
  const user = rejectUser(id, req.session.email);
  res.json({ success: true, data: user });
});

app.post("/api/admin/users/:id/scope", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "id invalido" });
  const scope = req.body?.allowedProjects || req.body?.scope;
  let projects = ["all"];
  if (Array.isArray(scope)) projects = scope;
  else if (typeof scope === "string" && scope.trim()) {
    projects = scope.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const user = updateUserScope(id, projects);
  res.json({ success: true, data: user });
});

// Escopos de projeto disponíveis no seletor
app.get("/api/scopes", requireAuth, (req, res) => {
  res.json({
    success: true,
    data: [
      { key: "to", label: "Tocantins (TO)", projectKey: "TO", projectName: "TOCANTINS", description: "Apenas o projeto Tocantins" },
      { key: "all", label: "Toda Azinformática", projectKey: null, projectName: "Todos os projetos", description: "Todos os projetos da instância Jira" },
    ],
  });
});

app.get("/api/projects", requireAuth, async (req, res) => {
  try {
    const refresh = req.query.refresh === "true";
    const cacheKey = "projects";
    let data = refresh ? null : getCached(cacheKey);
    if (!data) {
      data = await fetchProjects();
      setCached(cacheKey, data, 300_000);
    }
    const visible = filterProjectsForSession(data, req.session);
    res.json({ success: true, count: visible.length, data: visible, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

function validProjectKey(value) {
  return value === "all" || /^[A-Za-z0-9_]+$/.test(String(value || ""));
}

app.get("/api/chamados/abertos", requireAuth, requireProjectScope, async (req, res) => {
  try {
    // Compatibilidade com escopo antigo
    let project = req.query.project;
    if (!project && req.query.scope) {
      project = req.query.scope === "all" ? "all" : "TO";
    }
    if (!project) project = "TO";
    if (!validProjectKey(project)) {
      return res.status(400).json({ success: false, error: "Projeto inválido." });
    }
    const openOnly = !(req.query.open === "false" || req.query.open === "0");
    const query = String(req.query.q || "").trim().slice(0, 160);
    const sort = String(req.query.sort || "updated");
    const nextPageToken = String(req.query.nextPageToken || "").trim();
    const refresh = req.query.refresh === "true";
    const useSearch = Boolean(query || nextPageToken || req.query.sort);

    // Caminho classico (sem busca/paginação) mantem cache e formato antigo
    if (!useSearch) {
      const cacheKey = `abertos:${project}:${openOnly}`;
      let data = refresh ? null : getCached(cacheKey);
      const jql = jqlForProject(project, openOnly);
      if (!data) {
        data = await fetchAbertos(jql);
        setCached(cacheKey, data);
      }
      return res.json({
        success: true,
        source: "jira",
        project,
        openOnly,
        jql,
        filter: (project === "TO" && openOnly) ? config.jira.filterId : null,
        count: data.length,
        data,
        cached: !refresh && !!getCached(cacheKey),
        fetchedAt: new Date().toISOString(),
      });
    }

    // Caminho com busca/paginação/ordenacao server-side
    const result = await searchIssues({ projectKey: project, query, sort, nextPageToken, openOnly });
    res.json({
      success: true,
      source: "jira",
      project,
      openOnly,
      query,
      sort,
      count: result.issues.length,
      data: result.issues,
      total: result.total,
      nextPageToken: result.nextPageToken,
      isLast: result.isLast,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Chamados atrasados (SLA vencido ou sem resolução ha muito tempo)
app.get("/api/chamados/atrasados", requireAuth, requireProjectScope, async (req, res) => {
  try {
    const project = String(req.query.project || "TO").trim();
    if (!validProjectKey(project)) {
      return res.status(400).json({ success: false, error: "Projeto invalido." });
    }
    const dias = parseInt(req.query.dias || "7", 10);
    const allowed = req.session.allowedProjects || [];
    let scopeClause = `project = "${project}"`;
    if (!allowed.includes("all")) {
      const clauses = allowed.map((p) => `project = "${p}"`);
      scopeClause = `(${clauses.join(" OR ")})`;
    }
    // Atrasados: nao resolvidos e sem atualizacao ha mais de X dias, ou com vencimento SLA expirado
    const jql = `${scopeClause} AND resolution = Unresolved AND updated < -${dias}d ORDER BY updated ASC`;
    const fields = req.query.fields ? req.query.fields.split(",") : DEFAULT_FIELDS;
    const issues = await fetchIssuesByJql(jql, fields, config.jira.maxResults);
    res.json({
      success: true,
      source: "jira",
      project,
      dias,
      jql,
      count: issues.length,
      data: issues.map(normalizeIssue),
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Alias estilo painel (zip): /api/issues com paginacao/busca/ordenacao
app.get("/api/issues", requireAuth, requireProjectScope, async (req, res) => {
  try {
    const project = String(req.query.project || "all").trim();
    if (!validProjectKey(project)) return res.status(400).json({ success: false, error: "Projeto inválido." });
    const query = String(req.query.q || "").trim().slice(0, 160);
    const sort = String(req.query.sort || "updated");
    const nextPageToken = String(req.query.nextPageToken || "").trim();
    const openOnly = !(req.query.open === "false" || req.query.open === "0");
    const result = await searchIssues({ projectKey: project === "all" ? "" : project, query, sort, nextPageToken, openOnly });
    res.json({ success: true, issues: result.issues, total: result.total, nextPageToken: result.nextPageToken, isLast: result.isLast, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Alias estilo painel (zip): /api/projects (ja existe, mas garantimos mesmo caminho)
// /api/attachments/:id -> /api/attachment/:id
app.get("/api/attachments/:id", requireAuth, async (req, res) => {
  req.url = `/api/attachment/${req.params.id}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  // delega para handler existente redirecionando
  res.redirect(307, `/api/attachment/${encodeURIComponent(req.params.id)}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`);
});

app.get("/api/filter/:id", requireAuth, async (req, res) => {
  try {
    const filter = await fetchFilter(req.params.id);
    res.json({ success: true, data: filter });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Endpoint generico: permite JQL customizado via query param (util para outros sistemas)
app.get("/api/jql", requireAuth, requireProjectScope, async (req, res) => {
  const jql = req.query.jql;
  if (!jql) return res.status(400).json({ success: false, error: "param 'jql' obrigatorio" });
  const project = req.query.project;
  if (project && !validProjectKey(project)) {
    return res.status(400).json({ success: false, error: "Projeto inválido." });
  }
  const fields = req.query.fields ? req.query.fields.split(",") : DEFAULT_FIELDS;
  const limit = parseInt(req.query.limit || String(config.jira.maxResults), 10);
  // Restringe o escopo quando o usuario nao tem acesso total
  const allowed = req.session.allowedProjects || [];
  let effectiveJql = jql;
  if (!allowed.includes("all")) {
    const clauses = allowed.map((p) => `project = "${p}"`);
    effectiveJql = `(${jql}) AND (${clauses.join(" OR ")})`;
  }
  try {
    const issues = await fetchIssuesByJql(effectiveJql, fields, limit);
    res.json({
      success: true,
      count: issues.length,
      data: issues.map(normalizeIssue),
      jql: effectiveJql,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// --- Fluxo de atividades do Jira (projeto TO) ---
app.get("/api/atividades", requireAuth, requireProjectScope, async (req, res) => {
  try {
    let project = req.query.project;
    if (!project && req.query.scope) project = req.query.scope === "all" ? "all" : "TO";
    if (!project) project = "TO";
    const openOnly = req.query.open === "true" || req.query.open === "1";
    const limit = parseInt(req.query.limit || "60", 10);
    const refresh = req.query.refresh === "true";
    const cacheKey = `atividades:${project}:${openOnly}`;
    let data = refresh ? null : getCached(cacheKey);
    if (!data) {
      data = await fetchRecentActivity(limit, jqlForProject(project, openOnly));
      setCached(cacheKey, data, 120_000);
    }
    res.json({ success: true, project, openOnly, count: data.length, data, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/issue/:key", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const details = await fetchIssueDetails(req.params.key);
    res.json({ success: true, data: details, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/issue/:key/comments", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const comments = await fetchComments(req.params.key);
    res.json({ success: true, count: comments.length, data: comments, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Cria nota/comentario direto no chamado (interno = nota interna JSM)
app.post("/api/issue/:key/note", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const key = req.params.key;
    const body = String(req.body?.body || "").trim();
    const internal = req.body?.internal !== false;
    const mentions = Array.isArray(req.body?.mentions)
      ? req.body.mentions
          .filter((m) => m && (m.accountId || m.id) && m.name)
          .map((m) => ({ accountId: m.accountId || m.id, name: String(m.name).trim() }))
      : [];
    if (!body) return res.status(400).json({ success: false, error: "Texto da nota obrigatorio." });
    if (body.length > 5000) return res.status(400).json({ success: false, error: "Nota muito longa (max. 5000 caracteres)." });
    const comment = await createComment(key, body, { internal, mentions });
    res.json({ success: true, data: comment, created: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Cria uma nova tarefa (issue) no projeto CSP - Suporte Presencial
// Preenche automaticamente: projeto=CSP, tipo=Tarefa (id 10030), reporter=usuário logado
// O usuário informa: summary (obrigatório), description (opcional), assignee (opcional)
// Tambem pode informar manualmente o nome da pessoa e do cliente
// O summary eh gravado com o prefixo "[TOCANTINS] - Pessoa: [nome] - Cliente: [nome]"
app.post("/api/issue/create", requireAuth, async (req, res) => {
  try {
    const { summary, description, assigneeAccountId, pessoa, cliente } = req.body || {};
    if (!summary || !String(summary).trim()) {
      return res.status(400).json({ success: false, error: "Resumo é obrigatório." });
    }

    // Monta o resumo com prefixos opcionais (SIN [TOCANTINS])
    let summaryFinal = String(summary).trim();
    const pessoaTrim = String(pessoa).trim();
    const clienteTrim = String(cliente).trim();
    const prefixParts = [];
    if (pessoaTrim) prefixParts.push(`Pessoa: ${pessoaTrim}`);
    if (clienteTrim) prefixParts.push(`Cliente: ${clienteTrim}`);
    if (prefixParts.length > 0) {
      summaryFinal = `${prefixParts.join(" - ")} - ${summaryFinal}`;
    }

    // Descobre o accountId do usuário logado no Jira para preencher o reporter
    let reporterAccountId = null;
    if (req.session?.email) {
      reporterAccountId = await getJiraAccountIdByEmail(req.session.email);
    }

    const fields = {
      project: { key: "CSP" },
      summary: summaryFinal,
      issuetype: { id: "10030" }, // "Tarefa" no projeto CSP
    };
    if (description && String(description).trim()) {
      fields.description = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: String(description).trim() }],
          },
        ],
      };
    }
    if (reporterAccountId) fields.reporter = { accountId: reporterAccountId };
    if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };

    const payload = { fields };

    const data = await jiraFetch("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const issueKey = data.key;

    // Auto-transiciona para "Finalizado" (id 31) imediatamente após a criação
    let transitionResult = null;
    try {
      // Descobre as transicoes disponiveis para esta issue
      const transRes = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: "GET",
      });
      const transitions = transRes.transitions || [];
      const finalizado = transitions.find((t) => String(t.id) === "31" || String(t.name).toLowerCase() === "finalizado");

      if (finalizado) {
        await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: String(finalizado.id) } }),
        });
        transitionResult = { id: finalizado.id, name: finalizado.name, to: finalizado.toName };
      }
    } catch (err) {
      // Falha na transicao nao invalida a criacao da issue
      console.warn(`Auto-transicao para Finalizado falhou para ${issueKey}:`, err.message);
    }

    // Quando a issue eh criada e automaticamente finalizada no mesmo dia,
    // a data de criado eh a mesma da resolucao (abriu hoje, fechou hoje).
    let resolutionDate = null;
    let createdAt = new Date().toISOString();
    if (transitionResult) {
      try {
        const issueRes = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=created,resolutiondate`);
        resolutionDate = issueRes.fields?.resolutiondate || null;
        // Data de criado = mesma data da resolucao (mesmo dia)
        createdAt = resolutionDate || new Date().toISOString();
      } catch (err) {
        console.warn(`Nao foi possivel obter resolutiondate de ${issueKey}:`, err.message);
        createdAt = new Date().toISOString();
      }
    }

    res.json({
      success: true,
      key: issueKey,
      id: data.id,
      url: `${config.jira.domain}/browse/${issueKey}`,
      createdAt,
      resolutionDate,
      autoFinalizado: transitionResult ? transitionResult : null,
    });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message || "Erro ao criar tarefa no Jira." });
  }
});

// Lista usuarios do Jira para dropdown de responsavel (assignee)
app.get("/api/users", requireAuth, async (req, res) => {
  try {
    const q = req.query.q || "";
    const users = await searchJiraUsers(q, 100);
    res.json({ success: true, count: users.length, data: users });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message || "Erro ao buscar usuarios do Jira." });
  }
});

// Transiciona o status de uma issue no Jira (ex: Aberto / Em Atendimento / Finalizado)
// Descobre as transicoes disponiveis e aplica a escolhida pelo nome ou id
app.post("/api/issue/:key/transition", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const key = req.params.key;
    const { transitionId, transitionName } = req.body || {};
    if (!transitionId && !transitionName) {
      return res.status(400).json({ success: false, error: "transitionId ou transitionName e obrigatorio." });
    }

    // Descobre transicoes disponiveis para esta issue
    const transRes = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "GET",
    });
    const transitions = transRes.transitions || [];

    let chosen = null;
    if (transitionId) {
      chosen = transitions.find((t) => String(t.id) === String(transitionId));
    } else if (transitionName) {
      chosen = transitions.find((t) => String(t.name).toLowerCase() === String(transitionName).toLowerCase());
    }
    if (!chosen) {
      const available = transitions.map((t) => `${t.id}: ${t.name}`).join(", ");
      return res.status(400).json({ success: false, error: `Transicao nao encontrada. Disponiveis: ${available}` });
    }

    // Descobre campos obrigatorios da tela de transicao
    const meta = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`, {
      method: "GET",
    });
    const transEntry = (meta.transitions || []).find((t) => String(t.id) === String(chosen.id));
    const fieldsPayload = {};
    if (transEntry && transEntry.fields) {
      for (const [fieldId, fieldMeta] of Object.entries(transEntry.fields)) {
        if (fieldMeta.required && !fieldsPayload[fieldId]) {
          // Campo obrigatorio nao preenchido: reportar ao usuario
          return res.status(400).json({
            success: false,
            error: `Campo obrigatorio na preenchido para a transicao "${chosen.name}": ${fieldMeta.name || fieldId} (${fieldId})`,
            requiredField: fieldId,
            requiredFieldName: fieldMeta.name,
          });
        }
      }
    }

    const payload = {
      transition: { id: String(chosen.id) },
      fields: fieldsPayload,
    };

    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // Verifica resultado com leitura nativa
    const updated = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,assignee,summary`);
    res.json({
      success: true,
      key,
      transition: { id: chosen.id, name: chosen.name, to: chosen.toName },
      status: updated.fields?.status?.name || null,
      assignee: updated.fields?.assignee ? { name: updated.fields.assignee.displayName, accountId: updated.fields.assignee.accountId } : null,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message || "Erro ao transicionar status da issue." });
  }
});

app.get("/api/issue/:key/worklog", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const worklogs = await fetchWorklogs(req.params.key);
    res.json({ success: true, count: worklogs.length, data: worklogs, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Analise do chamado: intencao do cliente + conversa com suporte
app.get("/api/issue/:key/analysis", requireAuth, issueProjectGuard, async (req, res) => {
  try {
    const details = await fetchIssueDetails(req.params.key);
    const issue = details.issue;
    const comments = details.comments || [];
    const histories = (details.changelog?.histories || []).slice().sort((a,b)=>new Date(a.created)-new Date(b.created));

    const reporterName = issue.reporter ? issue.reporter.name : null;
    const clientComments = comments.filter(c => c.author && c.author.name === reporterName);
    const supportComments = comments.filter(c => !c.author || c.author.name !== reporterName);

    // intencao do cliente: summary + description + primeiro comentario do cliente
    const firstClientMsg = clientComments.length ? clientComments[0].body : (comments.length ? comments[0].body : "");
    const intent = {
      summary: issue.summary,
      reporter: reporterName,
      assignee: issue.assignee ? issue.assignee.name : null,
      status: issue.status,
      priority: issue.priority,
      created: issue.created,
      description: details.description ? (typeof details.description === "string" ? details.description : JSON.stringify(details.description)) : null,
      firstClientMessage: firstClientMsg || null,
    };

    // conversa com suporte: comentarios ordenados, marcando cliente vs suporte
    const conversation = comments
      .slice().sort((a,b)=>new Date(a.created)-new Date(b.created))
      .map(c => ({
        author: c.author ? c.author.name : "—",
        role: (c.author && c.author.name === reporterName) ? "cliente" : "suporte",
        date: c.created,
        body: c.body,
      }));

    // transicoes de status
    const transitions = [];
    histories.forEach(h => {
      (h.items||[]).forEach(it => {
        if ((it.field||"").toLowerCase().includes("status") || (it.field||"").toLowerCase().includes("assignee")) {
          transitions.push({
            field: it.field,
            from: it.fromString,
            to: it.toString,
            author: h.author ? h.author.displayName : null,
            date: h.created,
          });
        }
      });
    });

    res.json({ success: true, data: { intent, conversation, transitions, attachments: issue.attachments || [] }, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Proxy de anexos (imagens/arquivos) do Jira, para visualização/download no browser
app.get("/api/attachment/:id", async (req, res) => {
  try {
    const meta = await fetchAttachmentMeta(req.params.id);
    const contentRes = await fetch(meta.content, {
      headers: { Authorization: jiraAuthHeader(), Accept: "*/*" },
      signal: AbortSignal.timeout(30000),
    });
    if (!contentRes.ok) {
      return res.status(contentRes.status).json({ success: false, error: `Jira ${contentRes.status}` });
    }
    const buf = Buffer.from(await contentRes.arrayBuffer());
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    const disposition = (meta.mimeType || "").startsWith("image/") ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${meta.filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Proxy de miniatura de anexo
app.get("/api/attachment/:id/thumbnail", async (req, res) => {
  try {
    const meta = await fetchAttachmentMeta(req.params.id);
    const thumbUrl = meta.thumbnail || meta.content;
    const contentRes = await fetch(thumbUrl, {
      headers: { Authorization: jiraAuthHeader(), Accept: "*/*" },
      signal: AbortSignal.timeout(30000),
    });
    if (!contentRes.ok) {
      return res.status(contentRes.status).json({ success: false, error: `Jira ${contentRes.status}` });
    }
    const buf = Buffer.from(await contentRes.arrayBuffer());
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buf);
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ===== Integracao Pipefy =====
// Status da integracao (verifica configuracao)
app.get("/api/pipefy/status", requireAuth, (req, res) => {
  res.json({
    success: true,
    configured: isPipefyConfigured(),
    pipeId: config.pipefy.pipeId || null,
    apiUrl: config.pipefy.apiUrl,
    fieldMap: config.pipefy.fieldMap,
  });
});

// Detalhes do pipe (fases + campos) — util para mapear field_ids
app.get("/api/pipefy/pipe", requireAuth, async (req, res) => {
  try {
    if (!isPipefyConfigured()) {
      return res.status(400).json({ success: false, error: "Pipefy nao configurado (PIPEFY_TOKEN/PIPEFY_PIPE_ID ausentes)." });
    }
    const pipe = await fetchPipe(req.query.pipeId);
    res.json({ success: true, data: pipe, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Lista cards de um pipe
app.get("/api/pipefy/cards", requireAuth, async (req, res) => {
  try {
    if (!isPipefyConfigured()) {
      return res.status(400).json({ success: false, error: "Pipefy nao configurado." });
    }
    const first = parseInt(req.query.limit || "50", 10);
    const cards = await fetchCards(req.query.pipeId, first, req.query.after || null);
    res.json({ success: true, count: cards.edges.length, data: cards, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Sincroniza chamados abertos do Jira para o Pipefy (cria cards)
app.post("/api/pipefy/sync", requireAuth, requireProjectScope, async (req, res) => {
  try {
    if (!isPipefyConfigured()) {
      return res.status(400).json({ success: false, error: "Pipefy nao configurado (PIPEFY_TOKEN/PIPEFY_PIPE_ID ausentes)." });
    }
    const project = req.body?.project || req.query.project || "TO";
    const openOnly = req.body?.openOnly !== false;
    const jql = jqlForProject(project, openOnly);
    const issues = await fetchAbertos(jql);
    const result = await syncIssuesToPipefy(issues);
    res.json({
      success: true,
      project,
      openOnly,
      jql,
      total: result.total,
      created: result.created.length,
      errors: result.errors.length,
      data: result,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// Webhook Pipefy -> Jira (recebe eventos de cards)
app.post("/api/pipefy/webhook", (req, res) => {
  // Pipefy envia o payload no body. Valide a assinatura se configurar um secret.
  const event = req.body?.event || req.body?.action || null;
  const data = req.body?.data || req.body || {};
  console.log("[pipefy webhook]", event, JSON.stringify(data).slice(0, 500));
  // TODO: mapear eventos (card.move, card.update) para atualizacoes no Jira
  res.status(200).json({ received: true, event });
});

// Release Notes spaces list
app.get("/api/release/spaces", (req, res) => {
  try {
    const args = ["confluence","space","list","--output","json","--limit","200"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: twgErrorMessage(result) });
    }
    const stdout = readTwgOutput(result.stdout);
    const data = JSON.parse(stdout);
    const spaces = Array.isArray(data.data) ? data.data : data;
    const items = spaces.map(s => ({ key: s.key, name: s.name, id: s.id, type: s.type, status: s.status })).filter(s => s.key && s.name);
    return res.json({ success: true, spaces: items });
  } catch (err) {
    console.error("twg spaces error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// Release Notes TWG search
app.get("/api/release/search", (req, res) => {
  const term = (req.query.term || req.query.version || "").toString().trim();
  const module = (req.query.module || "").toString().trim();
  const space = (req.query.space || "").toString().trim();
  const dateFrom = (req.query.dateFrom || "").toString().trim();
  const dateTo = (req.query.dateTo || "").toString().trim();
  const parts = [
    "type=page",
    'title ~ "Nota de Release"'
  ];
  if (term) parts.push(`title ~ "${term.replace(/"/g, '\\"')}"`);
  if (module) parts.push(`text ~ "${module.replace(/"/g, '\\"')}"`);
  if (space) parts.push(`space = "${space.replace(/"/g, '\\"')}"`);
  if (dateFrom) parts.push(`lastmodified >= "${dateFrom}"`);
  if (dateTo) parts.push(`lastmodified <= "${dateTo}"`);
  if (!dateFrom && !dateTo) parts.push('lastmodified >= now("-365d")');
  const cql = parts.join(" AND ");
  let items = [];
  let errorMsg = null;
  try {
    const args = ["confluence","search","query","--cql",cql,"--limit","50","--output","json"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status !== 0) {
      errorMsg = twgErrorMessage(result);
    } else {
      // TWG may output a summary with JSON file path when stdout is not a TTY
      const stdout = readTwgOutput(result.stdout);
      try {
        const data = JSON.parse(stdout);
        const results = (data.data && Array.isArray(data.data.results)) ? data.data.results : (Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []));
        items = results.map(r => {
          const title = r.title || r.content?.title || "";
          const id = r.content?.id || r.id || "";
          const rawUrl = r.url || "";
          const spaceMatch = rawUrl.match(/\/spaces\/([^/]+)\/pages/);
          const spaceKey = spaceMatch ? spaceMatch[1] : (r.spaceKey || "");
          const url = rawUrl.startsWith("http") ? rawUrl : `https://aztecnologia.atlassian.net/wiki${rawUrl}`;
          const lastModified = r.lastModified || r.updated || r.content?.history?.lastUpdated || "";
          const versionMatch = title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i) || title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i);
          const version = versionMatch ? versionMatch[1] : "";
          return { id, title, spaceKey, url, lastModified, version };
        });
      } catch (e) {
        // fallback text parse
        const lines = stdout.split("\n");
        let currentTitle = null;
        for (let i=0;i<lines.length;i++) {
          const line = lines[i].trim();
          const titleMatch = line.match(/^\d+\.\s+(.+?)\s+\[page\]$/);
          if (titleMatch) { currentTitle = titleMatch[1].trim(); continue; }
          if (line.startsWith("http") && currentTitle) {
            items.push({ id:"", title: currentTitle, spaceKey: space, url: line, lastModified:"", version:"" });
            currentTitle = null;
          }
        }
      }
    }
  } catch (err) {
    console.error("twg search error:", err);
    errorMsg = err.message;
  }
  return res.json({ success: true, items, cql, term, module, space, error: errorMsg });
});

app.get("/api/release/content", (req, res) => {
  const id = (req.query.id || "").toString().trim();
  if (!id) return res.status(400).json({ success: false, error: "id obrigatório" });
  try {
    const args = ["confluence","content","get",id,"--format","html","--detail","full","--include-metadata","--output","json"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: twgErrorMessage(result), output: result.stdout || "" });
    }
    const stdout = readTwgOutput(result.stdout);
    let data;
    try { data = JSON.parse(stdout); } catch { data = { body: stdout }; }
    const payload = data.data || data;
    const title = payload.title || data.page?.title || "";
    let space = payload.space?.key || data.space?.key || data.spaceKey || "";
    let url = payload._links?.webui ? `https://aztecnologia.atlassian.net/wiki${payload._links.webui}` : (data.url || data.page?.url || "");
    const lastModified = payload.metadata?.version?.createdAt || payload.history?.lastUpdated || data.lastModified || data.history?.lastUpdated || "";
    // If space not present, try to resolve via spaceId
    if (!space && payload.spaceId) {
      try {
        const spArgs = ["confluence","space","get",payload.spaceId,"--output","json"];
        const spRes = runTwg(spArgs, { timeout: 8000 });
        const spOut = readTwgOutput(spRes.stdout);
        const spData = JSON.parse(spOut);
        const spPayload = spData.data || spData;
        space = spPayload.key || space;
        // Build URL from space and id if possible
        if (!url && space && payload.id) {
          url = `https://aztecnologia.atlassian.net/wiki/spaces/${space}/pages/${payload.id}`;
        }
      } catch {}
    }
    // TWG content get body is in payload.body.value when detail full
    let htmlBody = "";
    if (payload.body && typeof payload.body === 'object') {
      htmlBody = payload.body.value || "";
    } else if (typeof payload.body === 'string') {
      htmlBody = payload.body;
    } else {
      htmlBody = payload.content || data.body || data.content || "";
    }
    // Build markdown in GER pattern
    const versionMatch = title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i) || title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i);
    const version = versionMatch ? versionMatch[1] : "";
    const system = title.split(/[-v]/)[0].trim();
    // Extract version date from HTML if present
    let dateText = "";
    const dateMatch = htmlBody.match(/<time[^>]*datetime="([^"]+)"/);
    if (dateMatch) dateText = dateMatch[1];
    const pubDate = dateText || lastModified;
    // Extract first table rows for corrections
    let tableRows = "";
    const tableMatch = htmlBody.match(/<table[^>]*>[\s\S]*?<\/table>/i);
    if (tableMatch) {
      const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      const dataRows = rows.slice(1); // skip header
      const extracted = dataRows.map(r => {
        const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => {
          let txt = c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          // decode basic entities
          txt = txt.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
          // truncate long descriptions
          return txt.length > 300 ? txt.slice(0,297)+'…' : txt;
        });
        if (cells.length >= 2) {
          const ticket = cells[0].replace(/\|/g,' ');
          const desc = cells[1].replace(/\|/g,' ');
          return `| ${ticket} | ${desc} |`;
        }
        return null;
      }).filter(Boolean);
      if (extracted.length) {
        tableRows = "\n" + extracted.join("\n");
      }
    }
    const markdown = `# ${system} ${version}\n# Nota de Release — v${version}\n**Data de publicação:** ${pubDate}\n## 1. Correções realizadas\n| Ticket | Descrição |\n|---|---|\n${tableRows}`;
    return res.json({ success: true, markdown, html: htmlBody, meta: { space, title, url, lastModified, version } });
  } catch (err) {
    console.error("twg content error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// Release Notes PDF report
app.get("/api/release/report", async (req, res) => {
  try {
    const term = (req.query.term || "").toString().trim();
    const module = (req.query.module || "").toString().trim();
    const space = (req.query.space || "").toString().trim();
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    // Reuse search logic
    const parts = ["type=page",'title ~ "Nota de Release"'];
    if (term) parts.push(`title ~ "${term.replace(/"/g,'\\"')}"`);
    if (module) parts.push(`text ~ "${module.replace(/"/g,'\\"')}"`);
    if (space) parts.push(`space = "${space.replace(/"/g,'\\"')}"`);
    if (dateFrom) parts.push(`lastmodified >= "${dateFrom}"`);
    if (dateTo) parts.push(`lastmodified <= "${dateTo}"`);
    if (!dateFrom && !dateTo) parts.push('lastmodified >= now("-365d")');
    const cql = parts.join(" AND ");
    const args = ["confluence","search","query","--cql",cql,"--limit","50","--output","json"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: twgErrorMessage(result) });
    }
    const stdout = readTwgOutput(result.stdout);
    const data = JSON.parse(stdout);
    const results = (data.data && Array.isArray(data.data.results)) ? data.data.results : (Array.isArray(data.results) ? data.results : []);
    const items = results.map(r => {
      const title = r.title || r.content?.title || "";
      const id = r.content?.id || r.id || "";
      const rawUrl = r.url || "";
      const spaceMatch = rawUrl.match(/\/spaces\/([^/]+)\/pages/);
      const spaceKey = spaceMatch ? spaceMatch[1] : (r.spaceKey || "");
      const url = rawUrl.startsWith("http") ? rawUrl : `https://aztecnologia.atlassian.net/wiki${rawUrl}`;
      const lastModified = r.lastModified || r.updated || "";
      const versionMatch = title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i) || title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i);
      const version = versionMatch ? versionMatch[1] : "";
      return { id, title, spaceKey, url, lastModified, version };
    }).filter(i=>i.id);
    // Agrupar por espaço e ordenar por data
    const grouped = {};
    items.forEach(i=>{ (grouped[i.spaceKey] ||= []).push(i); });
    Object.values(grouped).forEach(arr=>arr.sort((a,b)=> new Date(b.lastModified||0)-new Date(a.lastModified||0)));
    return res.json({ success: true, grouped, total: items.length, cql });
  } catch (err) {
    console.error("report error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// Release Notes PDF report agrupado por espaço
app.get("/api/release/pdf", async (req, res) => {
  try {
    const term = (req.query.term || "").toString().trim();
    const space = (req.query.space || "").toString().trim();
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const parts = ["type=page",'title ~ "Nota de Release"'];
    if (term) parts.push(`title ~ "${term.replace(/"/g,'\\"')}"`);
    if (space) parts.push(`space = "${space.replace(/"/g,'\\"')}"`);
    if (dateFrom) parts.push(`lastmodified >= "${dateFrom}"`);
    if (dateTo) parts.push(`lastmodified <= "${dateTo}"`);
    if (!dateFrom && !dateTo) parts.push('lastmodified >= now("-365d")');
    const cql = parts.join(" AND ");
    const args = ["confluence","search","query","--cql",cql,"--limit","50","--output","json"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status!==0) return res.status(502).json({success:false,error:twgErrorMessage(result)});
    const stdout = readTwgOutput(result.stdout);
    const data = JSON.parse(stdout);
    const results = (data.data&&Array.isArray(data.data.results))?data.data.results:Array.isArray(data.results)?data.results:[];
    const items = results.map(r=>{ const title=r.title||r.content?.title||""; const id=r.content?.id||r.id||""; const rawUrl=r.url||""; const sm=rawUrl.match(/\/spaces\/([^/]+)\/pages/); const spaceKey=sm?sm[1]:r.spaceKey||""; const url=rawUrl.startsWith("http")?rawUrl:`https://aztecnologia.atlassian.net/wiki${rawUrl}`; const lastModified=r.lastModified||r.updated||""; const vm=title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i)||title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i); const version=vm?vm[1]:""; return {id,title,spaceKey,url,lastModified,version}; }).filter(i=>i.id);
    const grouped={}; items.forEach(i=>{(grouped[i.spaceKey]||=[]).push(i)}); Object.values(grouped).forEach(arr=>arr.sort((a,b)=>new Date(b.lastModified||0)-new Date(a.lastModified||0)));
    
    // Helper to fetch content HTML
    const fetchContentHtml = async (id) => {
      try {
        const args = ["confluence","content","get",id,"--format","html","--detail","full","--include-metadata","--output","json"];
        const r = runTwg(args, { timeout: 10000 });
        if (r.error || r.status!==0) return "";
        const out = readTwgOutput(r.stdout);
        const d = JSON.parse(out);
        const payload = d.data||d;
        const html = payload.body?.value || payload.body?.storage?.value || "";
        return html;
      } catch { return ""; }
    };
    const parseReleaseHtml = (html) => {
      const decodeHtml = (s) => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      const stripHtml = (s) => {
        let t = decodeHtml(s)
          .replace(/<br\s*\/?>/gi,'\n')
          .replace(/<\/p>/gi,'\n\n')
          .replace(/<\/div>/gi,'\n')
          .replace(/<[^>]+>/g,' ')
          .replace(/\s+\n/g,'\n')
          .replace(/\n\s+/g,'\n');
        t = t.replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim();
        return t;
      };
      const normalizeCategory = (c) => {
        const lc = c.toLowerCase();
        if (/funcional|adicion/.test(lc)) return 'Funcionalidades adicionadas';
        if (/melhor/.test(lc)) return 'Melhorias realizadas';
        if (/manuten/.test(lc)) return 'Manutenções realizadas';
        if (/corre/.test(lc)) return 'Correções realizadas';
        return c.trim();
      };
      const productMatch = html.match(/<h1[^>]*>[^<]*Projeto:[^<]*<strong>([^<]+)<\/strong>/i);
      const product = productMatch ? productMatch[1].trim() : '';
      const versionMatch = html.match(/<h2[^>]*>\s*Vers[oã]o:\s*([^<]+)<\/h2>/i);
      const version = versionMatch ? versionMatch[1].trim() : '';
      const dateMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
      const date = dateMatch ? new Date(dateMatch[1]).toLocaleDateString('pt-BR') : '';
      const sections = [];
      const secRe = /<h3[^>]*>([^<]+)<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/gi;
      let m;
      while ((m = secRe.exec(html)) !== null) {
        const category = normalizeCategory(stripHtml(m[1]));
        const tableHtml = m[2];
        const rows = [];
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        let first = true;
        while ((rm = rowRe.exec(tableHtml)) !== null) {
          if (first) { first = false; continue; }
          const rowHtml = rm[1];
          const cells = [];
          const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let cm;
          while ((cm = cellRe.exec(rowHtml)) !== null) {
            cells.push(stripHtml(cm[1]));
          }
          if (cells.length >= 2) rows.push({ ticket: cells[0], desc: cells[1] });
        }
        if (rows.length) sections.push({ category, rows });
      }
      if (!sections.length) {
        const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
        let tm;
        while ((tm = tableRe.exec(html)) !== null) {
          const rows = [];
          const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let rm2;
          let first2 = true;
          while ((rm2 = rowRe.exec(tm[1])) !== null) {
            if (first2) { first2 = false; continue; }
            const rowHtml = rm2[1];
            const cells = [];
            const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let cm2;
            while ((cm2 = cellRe.exec(rowHtml)) !== null) {
              cells.push(stripHtml(cm2[1]));
            }
            if (cells.length >=2) rows.push({ ticket: cells[0], desc: cells[1] });
          }
          if (rows.length) sections.push({ category: 'Itens', rows });
        }
      }
      return { product, version, date, sections };
    };
    
    // Generate PDF with content - paleta do sistema
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const safe = s => String(s||'').replace(/[^\u0020-\u00FF]/g,'');
    const NAVY = rgb(0, 36/255, 54/255);
    const ACCENT = rgb(234/255, 79/255, 36/255);
    const MUTED = rgb(87/255, 87/255, 86/255);
    const drawWrapped = (page,y,txt,size=10)=>{ const maxW=500; const words=safe(txt).split(' '); let line=''; let curY=y; for(const w of words){ if((line+w).length*size*0.6>maxW){ page.drawText(safe(line),{x:50,y:curY,font,size,color: rgb(0.12,0.12,0.12)}); curY-=size+2; line=w+' '; } else { line+=(w+' '); } } if(line) { page.drawText(safe(line),{x:50,y:curY,font,size,color: rgb(0.12,0.12,0.12)}); curY-=size+2; } return curY; };
    let logoImage = null;
    try {
      const logoBytes = await getLogoBytes();
      if (logoBytes) logoImage = await pdfDoc.embedPng(logoBytes);
    } catch {}
    const drawHeader = (page,height) => {
      page.drawRectangle({ x:0, y:height-50, width:595, height:50, color: NAVY });
      page.drawRectangle({ x:0, y:height-50, width:595, height:4, color: ACCENT });
      let logoWidth = 0;
      if (logoImage) {
        const logoHeight = 28;
        logoWidth = logoImage.width * logoHeight / logoImage.height;
        page.drawImage(logoImage, { x: 50, y: height - 50 + (50 - logoHeight)/2, width: logoWidth, height: logoHeight });
      }
      const title = "Notas de Release";
      const titleWidth = boldFont.widthOfTextAtSize(title, 18);
      const titleX = Math.max(50, Math.round((595 - titleWidth) / 2));
      page.drawText(title, { x:titleX, y:height-32, font: boldFont, size:18, color: rgb(1,1,1) });
    };
    let page = pdfDoc.addPage([595,842]);
    let { width, height } = page.getSize();
    drawHeader(page,height);
    let y = height - 70;
    
    const sortedSpaces = Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0]));
    for (const [spaceKey, notes] of sortedSpaces) {
      for (const n of notes) {
        if (y < 150) { page = pdfDoc.addPage([595,842]); ({width,height}=page.getSize()); drawHeader(page,height); y = height - 70; }
        const html = await fetchContentHtml(n.id);
        const rel = parseReleaseHtml(html);
        const version = rel.version || (n.version ? n.version : '');
        const title = `Nota de Release - ${version}`;
        page.drawText(safe(title), { x:50, y, font: boldFont, size:16, color: NAVY });
        y -= 18;
        page.drawText(safe(`Espaço: ${spaceKey}`), { x:50, y, font, size:9, color: MUTED });
        y -= 12;
        page.drawText(safe(`Produto: ${rel.product || ''}`), { x:50, y, font, size:9, color: rgb(0,0,0) });
        y -= 12;
        page.drawText(safe(`Versão: ${rel.version || version || ''}`), { x:50, y, font, size:9, color: rgb(0,0,0) });
        y -= 12;
        const dataStr = rel.date || (n.lastModified ? new Date(n.lastModified).toLocaleDateString('pt-BR') : '');
        page.drawText(safe(`Data: ${dataStr}`), { x:50, y, font, size:9, color: rgb(0,0,0) });
        y -= 12;
        const totalItens = rel.sections.reduce((s,sec)=>s+sec.rows.length,0);
        page.drawText(safe(`Quantidade de itens: ${totalItens}`), { x:50, y, font, size:9, color: rgb(0,0,0) });
        y -= 18;
        // Resumo
        page.drawText(safe('Resumo'), { x:50, y, font: boldFont, size:11, color: NAVY });
        y -= 14;
        rel.sections.forEach(sec => {
          page.drawText(safe(`${sec.category}: ${sec.rows.length}`), { x:60, y, font, size:9, color: rgb(0,0,0) });
          y -= 12;
        });
        y -= 6;
        // Seções detalhadas
        for (const sec of rel.sections) {
          if (y < 120) { page = pdfDoc.addPage([595,842]); ({width,height}=page.getSize()); drawHeader(page,height); y = height - 70; }
          page.drawText(safe(sec.category), { x:50, y, font: boldFont, size:11, color: NAVY });
          y -= 14;
          // cabeçalho da tabela
          page.drawText(safe('Incidente / Ticket'), { x:50, y, font: boldFont, size:9, color: rgb(0,0,0) });
          page.drawText(safe('Descrição da alteração'), { x:200, y, font: boldFont, size:9, color: rgb(0,0,0) });
          y -= 12;
          for (const row of sec.rows) {
            if (y < 70) { page = pdfDoc.addPage([595,842]); ({width,height}=page.getSize()); drawHeader(page,height); y = height - 70; }
            const ticket = safe(row.ticket);
            const desc = safe(row.desc);
            const ticketMaxW = 140;
            const descMaxW = 340;
            const wrapLines = (txt, maxW) => {
              const words = txt.split(' ');
              const lines = [];
              let line = '';
              for (const w of words) {
                const test = line ? line + ' ' + w : w;
                if (font.widthOfTextAtSize(test, 9) > maxW) {
                  if (line) lines.push(line);
                  line = w;
                } else {
                  line = test;
                }
              }
              if (line) lines.push(line);
              return lines.length ? lines : [''];
            };
            const ticketLines = wrapLines(ticket, ticketMaxW);
            const descLines = wrapLines(desc, descMaxW);
            const rowLines = Math.max(ticketLines.length, descLines.length);
            for (let i = 0; i < rowLines; i++) {
              if (y < 70) { page = pdfDoc.addPage([595,842]); ({width,height}=page.getSize()); drawHeader(page,height); y = height - 70; }
              if (ticketLines[i]) page.drawText(ticketLines[i], { x:50, y, font, size:9, color: rgb(0,0,0) });
              if (descLines[i]) page.drawText(descLines[i], { x:200, y, font, size:9, color: rgb(0,0,0) });
              y -= 11;
            }
          }
          y -= 10;
        }
        y -= 20;
      }
    }
    
    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="release-notes-${Date.now()}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(err){ console.error("pdf error:",err); return res.status(502).json({success:false,error:err.message}); }
});

// Release Notes PDF Jira enrichment
app.get("/api/release/pdf-jira", async (req, res) => {
  try {
    const term = (req.query.term || "").toString().trim();
    const space = (req.query.space || "").toString().trim();
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const parts = ["type=page",'title ~ "Nota de Release"'];
    if (term) parts.push(`title ~ "${term.replace(/"/g,'\\"')}"`);
    if (space) parts.push(`space = "${space.replace(/"/g,'\\"')}"`);
    if (dateFrom) parts.push(`lastmodified >= "${dateFrom}"`);
    if (dateTo) parts.push(`lastmodified <= "${dateTo}"`);
    if (!dateFrom && !dateTo) parts.push('lastmodified >= now("-365d")');
    const cql = parts.join(" AND ");
    const args = ["confluence","search","query","--cql",cql,"--limit","50","--output","json"];
    const result = runTwg(args, { timeout: 15000 });
    if (result.error || result.status!==0) return res.status(502).json({success:false,error:twgErrorMessage(result)});
    const stdout = readTwgOutput(result.stdout);
    const data = JSON.parse(stdout);
    const results = (data.data&&Array.isArray(data.data.results))?data.data.results:Array.isArray(data.results)?data.results:[];
    const items = results.map(r=>{ const title=r.title||r.content?.title||""; const id=r.content?.id||r.id||""; const rawUrl=r.url||""; const sm=rawUrl.match(/\/spaces\/([^/]+)\/pages/); const spaceKey=sm?sm[1]:r.spaceKey||""; const url=rawUrl.startsWith("http")?rawUrl:`https://aztecnologia.atlassian.net/wiki${rawUrl}`; const lastModified=r.lastModified||r.updated||""; const vm=title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i)||title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i); const version=vm?vm[1]:""; return {id,title,spaceKey,url,lastModified,version}; }).filter(i=>i.id);
    const grouped={}; items.forEach(i=>{(grouped[i.spaceKey]||=[]).push(i)}); Object.values(grouped).forEach(arr=>arr.sort((a,b)=>new Date(b.lastModified||0)-new Date(a.lastModified||0)));

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    let page = pdfDoc.addPage([595,842]);
    let { width, height } = page.getSize();
    let y = height - 50;
    const lineHeight = 14;

    page.drawText("Notas de Release - Itens Jira", { x: 50, y, font: boldFont, size: 18 });
    y -= 30;

    // Helper to fetch content and extract keys
    const fetchContent = (id) => {
      const args2 = ["confluence","content","get",id,"--format","html","--detail","full","--include-metadata","--output","json"];
      const r = runTwg(args2, { timeout: 10000 });
      const out = readTwgOutput(r.stdout);
      try { const d=JSON.parse(out); const payload = d.data?.page || d.data || d; const html = payload.body?.storage?.value || payload.body?.value || ""; return html; } catch { return ""; }
    };

    const fetchJiraIssues = async (keys) => {
      if (!keys.length) return [];
      // Network access may be restricted; return empty to avoid hanging
      return [];
    };

    for (const [spaceKey, notes] of Object.entries(grouped)) {
      if (y < 120) { page = pdfDoc.addPage([595,842]); y = height - 50; }
      page.drawText(`Espaço: ${spaceKey}`, { x: 50, y, font: boldFont, size: 14 });
      y -= lineHeight + 6;
      for (const n of notes) {
        if (y < 100) { page = pdfDoc.addPage([595,842]); y = height - 50; }
        page.drawText(`${n.title} ${n.version ? 'v'+n.version : ''}`, { x: 60, y, font, size: 12 });
        y -= lineHeight;
        page.drawText(`Data: ${n.lastModified ? new Date(n.lastModified).toLocaleDateString('pt-BR') : ''}`, { x: 60, y, font, size: 10, color: rgb(0.3,0.3,0.3) });
        y -= lineHeight;
        page.drawText(`URL: ${n.url}`, { x: 60, y, font, size: 9, color: rgb(0,0,0.6) });
        y -= lineHeight + 4;
      }
      y -= 10;
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="release-notes-jira-${Date.now()}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(err){ console.error("pdf-jira error:",err); return res.status(502).json({success:false,error:err.message}); }
});

// Documentos NTP - Listar documentos
app.get("/api/ntp/documents", requireAuth, async (req, res) => {
  try {
    const { folder, status } = req.query;
    let sql = "SELECT * FROM ntp_documents WHERE 1=1";
    const params = [];
    if (folder) {
      sql += " AND folder_path = ?";
      params.push(folder);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY folder_path, title";
    const documents = db.prepare(sql).all(...params);
    return res.json({ success: true, total: documents.length, documents });
  } catch (err) {
    console.error("ntp documents error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});
  
// Documento NTP - Obter conteúdo
app.get("/api/ntp/documents/:pageId/content", requireAuth, async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const doc = db.prepare("SELECT * FROM ntp_documents WHERE confluence_page_id = ?").get(pageId);
    if (!doc) return res.status(404).json({ success: false, error: "Documento não encontrado." });
    
    // Ler o content_path se disponível, ou tentar buscar via twg
    let content = null;
    let contentType = null;
    let fileName = null;
    
    if (doc.content_path && fs.existsSync(doc.content_path)) {
      content = fs.readFileSync(doc.content_path, "utf-8");
      contentType = "text/plain";
      fileName = doc.title || "documento.ntp";
    } else {
      // Tentar buscar via twg CLI
      const twgArgs = ["confluence", "content", "get", pageId, "--format", "markdown", "--detail", "full", "-o", "json"];
      const twgResult = spawnSync("/opt/twg/bin/twg", twgArgs, {
        encoding: "utf-8",
        timeout: 15000,
        env: { ...process.env, HOME: process.env.HOME || "/home/casa", PATH: "/opt/twg/bin:" + (process.env.PATH || "") }
      });
      
      if (!twgResult.error && twgResult.stdout.trim()) {
        try {
          const parsed = JSON.parse(twgResult.stdout);
          content = parsed.data?.body?.value || parsed.data?.body || "";
          contentType = "text/html";
          fileName = doc.title || "documento.ntp";
        } catch(e) {
          // Ignore parse errors
        }
      }
    }
    
    if (content) {
      // Mark as downloaded and save content path
      const contentDir = path.join(__dirname, "..", "data", "ntp-content");
      if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });
      const contentPath = path.join(contentDir, `${pageId}.md`);
      fs.writeFileSync(contentPath, content, "utf-8");
      
      // Update document as downloaded
      db.prepare("UPDATE ntp_documents SET downloaded = 1, content_path = ?, synced_at = ? WHERE confluence_page_id = ?").run(
        contentPath,
        new Date().toISOString(),
        pageId
      );
      
      res.json({ success: true, content, contentType: contentType || "text/markdown", fileName: fileName || "documento.md" });
    } else {
      res.status(404).json({ success: false, error: "Conteúdo não disponível." });
    }
  } catch (err) {
    console.error("ntp document content error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Documentos NTP - Sincronizar (buscar documentos novos via twg)
app.post("/api/ntp/sync", requireAuth, async (req, res) => {
  try {
    // Usar twg CLI para obter a árvore de documentos
    const args = ["confluence", "tree", "--target", "2943877130", "--depth", "10", "--output", "json"];
    const result = spawnSync("/opt/twg/bin/twg", args, {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, HOME: process.env.HOME || "/home/casa", PATH: "/opt/twg/bin:" + (process.env.PATH || "") }
    });

    if (result.error || !result.stdout.trim()) {
      return res.status(502).json({ success: false, error: "TWG indisponível ou erro ao buscar árvore." });
    }

    let treeData;
    try {
      treeData = JSON.parse(result.stdout);
    } catch (e) {
      return res.status(502).json({ success: false, error: "Resposta inválida do TWG." });
    }

    const descendants = treeData.data?.descendants || [];
    let sincronizados = 0;
    let atualizados = 0;

    // Processar pastas e páginas
    const folders = {};
    const pages = [];

    for (const item of descendants) {
      if (item.type === "folder") {
        folders[item.id] = { ...item, children: [] };
      } else if (item.type === "page") {
        pages.push(item);
      }
    }

    // Insert/mark all folders first
    for (const [id, folder] of Object.entries(folders)) {
      const folderPath = folder.title;
      const existing = db.prepare("SELECT * FROM ntp_documents WHERE confluence_page_id = ? AND status = 'folder'").get(id);
      if (!existing) {
        db.prepare(`
          INSERT INTO ntp_documents (confluence_page_id, title, folder_path, url, status, downloaded, page_version, last_modified)
          VALUES (?, ?, ?, ?, 'folder', 0, 0, ?)
        `).run(id, folder.title, folderPath, new Date().toISOString());
        atualizados++;
      }
    }

    // Process pages - mark as pending download
    for (const page of pages) {
      // Find the folder path from the page's parent
      const parentFolder = folders[page.parentId];
      const pageFolderPath = parentFolder ? parentFolder.title : "";
      const existing = db.prepare("SELECT * FROM ntp_documents WHERE confluence_page_id = ?").get(page.id);
      if (!existing) {
        db.prepare(`
          INSERT INTO ntp_documents (confluence_page_id, title, folder_path, url, status, downloaded, page_version, last_modified)
          VALUES (?, ?, ?, ?, 'pending', 0, 0, ?)
        `).run(page.id, page.title, pageFolderPath, page.url || "", new Date().toISOString());
        sincronizados++;
      } else if (existing.downloaded === 0 && existing.status === 'pending') {
        // Update meta if changed
        updateDocumentMeta(page.id, page.title, pageFolderPath, page.url || "", "pending", page.version || 0, page.lastModified || "");
        atualizados++;
      }
    }

    // Assign folder paths based on parentId relationships
    // Build a map of folder id -> title for quick lookup
    const folderTitleMap = {};
    for (const item of descendants) {
      if (item.type === "folder") {
        folderTitleMap[item.id] = item.title;
      }
    }

    // Update folder_path for all pages based on their parentId
    for (const page of pages) {
      const parentFolderTitle = folderTitleMap[page.parentId] || "";
      if (parentFolderTitle) {
        db.prepare("UPDATE ntp_documents SET folder_path = ? WHERE confluence_page_id = ?").run(parentFolderTitle, page.id);
      }
    }

    // Update folder_path for root folders (parentId === "2943877130")
    for (const folder of Object.values(folders)) {
      if (folder.parentId === "2943877130") {
        db.prepare("UPDATE ntp_documents SET folder_path = ? WHERE confluence_page_id = ? AND status = 'folder'").run(folder.title, folder.id);
      }
    }

    return res.json({ success: true, sincronizados, atualizados, pending: countPending() });
  } catch (err) {
    console.error("ntp sync error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// Documentos NTP - Baixar todos os pendentes (em lotes de 5)
app.post("/api/ntp/download-all", requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "5", 10);
    const pending = db.prepare("SELECT * FROM ntp_documents WHERE downloaded = 0 AND status = 'pending' LIMIT ?").all(limit);
    let baixados = 0;
    let erros = 0;
    const contentDir = path.join(__dirname, "..", "data", "ntp-content");
    if (!fs.existsSync(contentDir)) fs.mkdirSync(contentDir, { recursive: true });

    for (const doc of pending) {
      try {
        const twgArgs = ["confluence", "content", "get", doc.confluence_page_id, "--format", "markdown", "--detail", "full", "-o", "json"];
        const twgResult = spawnSync("/opt/twg/bin/twg", twgArgs, {
          encoding: "utf-8",
          timeout: 10000,
          env: { ...process.env, HOME: process.env.HOME || "/home/casa", PATH: "/opt/twg/bin:" + (process.env.PATH || "") }
        });

        if (twgResult.error || !twgResult.stdout.trim()) {
          erros++;
          continue;
        }

        let content = null;
        try {
          const parsed = JSON.parse(twgResult.stdout);
          content = parsed.data?.body?.value || parsed.data?.body || "";
        } catch (e) {
          erros++;
          continue;
        }

        if (content) {
          const contentPath = path.join(contentDir, `${doc.confluence_page_id}.md`);
          fs.writeFileSync(contentPath, content, "utf-8");
          db.prepare("UPDATE ntp_documents SET downloaded = 1, content_path = ?, synced_at = ? WHERE confluence_page_id = ?").run(
            contentPath,
            new Date().toISOString(),
            doc.confluence_page_id
          );
          baixados++;
        } else {
          erros++;
        }
      } catch (e) {
        erros++;
      }
    }

    const totalPending = countPending();
    return res.json({ success: true, baixados, erros, pending: totalPending, hasMore: totalPending > 0 });
  } catch (err) {
    console.error("ntp download-all error:", err);
    return res.status(502).json({ success: false, error: err.message });
  }
});


// ---- Chamados encerrados: campos, normalização e dashboard ----
// customfield_10071 = "Sistemas" | customfield_10100 = "Classificar_Sistemas"
// customfield_10084 = "SLA de Resolução" | customfield_10132 = "Vencimento SLA"
const CHAMADOS_FIELDS = [
  "summary", "issuetype", "priority", "reporter", "created", "updated",
  "resolutiondate", "project",
  "customfield_10071", "customfield_10100", "customfield_10084", "customfield_10132"
].join(",");

function optionLabel(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(optionLabel).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const base = v.value || v.name || "";
    if (v.child) return [base, optionLabel(v.child)].filter(Boolean).join(" / ");
    return base;
  }
  return String(v);
}

function formatSla(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v.split("T")[0];
  if (Array.isArray(v)) return v.length ? v.map(formatSla).filter(Boolean).join(", ") : "—";
  if (typeof v === "object") {
    const cycles = Array.isArray(v.completedCycles) ? v.completedCycles : [];
    if (cycles.length) {
      const c = cycles[cycles.length - 1];
      const status = c.breached ? "Violado" : "Cumprido";
      const elapsed = c.elapsedTime?.friendly || "";
      const goal = c.goalDuration?.friendly || "";
      return elapsed && goal ? `${status} (${elapsed}/${goal})` : status;
    }
    if (v.remainingTime?.friendly) return `Em andamento (restam ${v.remainingTime.friendly})`;
    if (v.goalDuration?.friendly) return `Meta ${v.goalDuration.friendly}`;
    return optionLabel(v) || "—";
  }
  return String(v);
}

function countBy(items, field) {
  const out = {};
  for (const it of items) {
    const key = (it[field] || "Não informado").toString().trim() || "Não informado";
    out[key] = (out[key] || 0) + 1;
  }
  return Object.entries(out)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

function withPercent(entries, total) {
  return entries.map((e) => ({
    ...e,
    percent: total ? Number(((e.count / total) * 100).toFixed(1)) : 0,
  }));
}

function buildDashboard(items) {
  const total = items.length;
  return {
    total,
    porTipo: withPercent(countBy(items, "issuetype"), total),
    porPrioridade: withPercent(countBy(items, "priority"), total),
    porSistema: withPercent(countBy(items, "sistema"), total),
    expirados: withPercent(countBy(items, "expirado"), total),
  };
}

function normalizeClosedIssue(issue, project) {
  const f = issue.fields || {};
  const sistema =
    optionLabel(f.customfield_10071) ||
    optionLabel(f.customfield_10100) ||
    f.project?.key || project;
  const resolutionRaw = f.resolutiondate || f.resolution?.date || "";
  const cycles = Array.isArray(f.customfield_10084?.completedCycles) ? f.customfield_10084.completedCycles : [];
  const tipo = f.issuetype?.name || "";
  const noExpiryTypes = ["Adaptativa", "Banco de Dados", "Dúvida"];
  const isNoExpiry = noExpiryTypes.some(t => t.toLowerCase() === tipo.toLowerCase());
  return {
    key: issue.key,
    issuetype: tipo,
    project: f.project?.key || project,
    sistema,
    sla: formatSla(f.customfield_10084) !== "—" ? formatSla(f.customfield_10084) : formatSla(f.customfield_10132),
    summary: f.summary || "",
    reporter: f.reporter?.displayName || f.reporter?.name || "",
    priority: f.priority?.name || "",
    created: f.created ? f.created.split("T")[0] : "",
    updated: f.updated ? f.updated.split("T")[0] : "",
    resolutiondate: resolutionRaw ? resolutionRaw.split("T")[0] : "",
    expirado: isNoExpiry ? "Não" : (cycles.some((c) => c.breached) ? "Sim" : "Não"),
  };
}

async function fetchClosedIssues(project, dateFrom, dateTo, maxResults) {
  let jql = `project = "${project}" AND status = "Encerrado"`;
  if (dateFrom) jql += ` AND resolved >= "${dateFrom}"`;
  if (dateTo) jql += ` AND resolved <= "${dateTo}"`;
  const issues = await fetchIssuesByJql(jql, CHAMADOS_FIELDS, maxResults);
  const items = (issues || []).map((i) => normalizeClosedIssue(i, project));
  items.sort((a, b) => String(b.resolutiondate || "").localeCompare(String(a.resolutiondate || "")));
  return { items, jql };
}

// ============================================================================
// RELATORIO DE ATIVIDADE — Chamados criados por periodo
// ============================================================================

const ACTIVITY_FIELDS = [
  "summary", "issuetype", "status", "priority", "assignee", "reporter",
  "created", "updated", "resolutiondate", "project"
].join(",");

function normalizeActivityIssue(issue) {
  const f = issue.fields || {};
  const assignee =
    f.assignee?.displayName || f.assignee?.name || "Não atribuído";
  const reporter =
    f.reporter?.displayName || f.reporter?.name || "";
  const createdRaw = f.created || "";
  const createdDate = createdRaw ? createdRaw.split("T")[0] : "";
  const createdTime = createdRaw ? createdRaw.split("T")[1]?.split(".")[0] : "";
  return {
    key: issue.key,
    id: issue.id,
    summary: f.summary || "",
    issuetype: f.issuetype?.name || "",
    status: f.status?.name || "",
    priority: f.priority?.name || "",
    assignee,
    reporter,
    created: createdDate,
    createdTime,
    updated: f.updated ? f.updated.split("T")[0] : "",
    resolutiondate: f.resolutiondate ? f.resolutiondate.split("T")[0] : "",
    project: f.project?.key || "CSP",
    url: `${config.jira.domain}/browse/${issue.key}`,
  };
}

async function fetchActivityIssues(dateFrom, dateTo, maxResults = 500, searchQuery = "") {
  let jql = `project = "CSP"`;
  if (searchQuery) {
    jql += ` AND summary ~ "${searchQuery}"`;
  }
  if (dateFrom) jql += ` AND created >= "${dateFrom}"`;
  if (dateTo) jql += ` AND created <= "${dateTo}"`;
  jql += ` ORDER BY created ASC`;
  const issues = await fetchIssuesByJql(jql, ACTIVITY_FIELDS, maxResults);
  const items = (issues || []).map((i) => normalizeActivityIssue(i));
  items.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
  return { items, jql };
}

function buildActivityDashboard(items) {
  const total = items.length;
  return {
    total,
    porStatus: withPercent(countBy(items, "status"), total),
    porResponsavel: withPercent(countBy(items, "assignee"), total),
    porPrioridade: withPercent(countBy(items, "priority"), total),
    porDia: countBy(items, "created"),
  };
}

// Chamados encerrados
app.get("/api/chamados/encerrados", async (req, res) => {
  try {
    const project = (req.query.project || "").toString().trim();
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    if (!project) return res.status(400).json({ success:false, error:"Projeto obrigatório" });
    const { items, jql } = await fetchClosedIssues(project, dateFrom, dateTo, 200);
    res.json({ success:true, total: items.length, dashboard: buildDashboard(items), items, jql });
  } catch(err){ console.error("chamados encerrados error:",err); res.status(502).json({success:false,error:err.message}); }
});

app.get("/api/chamados/encerrados/pdf", async (req, res) => {
  try {
    const project = (req.query.project || "").toString().trim();
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    if (!project) return res.status(400).json({ success:false, error:"Projeto obrigatório" });
    const { items } = await fetchClosedIssues(project, dateFrom, dateTo, 500);
    items.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    const dashboard = buildDashboard(items);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const safe = (v) => String(v ?? "").replace(/[^\u0020-\u00FF]/g, "").replace(/\s+/g, " ").trim();
    let logoImage = null;
    try {
      const logoBytes = await getLogoBytes();
      if (logoBytes) logoImage = await pdfDoc.embedPng(logoBytes);
    } catch {}

    const PAGE_W = 842, PAGE_H = 595, MARGIN = 30, CONTENT_W = PAGE_W - MARGIN * 2;
    const COLUMNS = [
      { label: "Chamado", width: 62 },
      { label: "Sistema", width: 95 },
      { label: "Tipo", width: 60 },
      { label: "SLA", width: 110 },
      { label: "Prioridade", width: 52 },
      { label: "Resumo", width: 130 },
      { label: "Solicitante", width: 80 },
      { label: "Criado", width: 50 },
      { label: "Atualizado", width: 50 },
      { label: "Resolução", width: 50 },
      { label: "Expira", width: 43 },
    ];
    let colX = MARGIN;
    for (const c of COLUMNS) { c.x = colX; colX += c.width; }

    const wrap = (text, fnt, size, maxWidth) => {
      const words = safe(text).split(" ").filter(Boolean);
      if (!words.length) return [""];
      const lines = [];
      let line = "";
      for (const word of words) {
        let candidate = line ? `${line} ${word}` : word;
        while (fnt.widthOfTextAtSize(candidate, size) > maxWidth) {
          let cut = candidate.length - 1;
          while (cut > 1 && fnt.widthOfTextAtSize(candidate.slice(0, cut), size) > maxWidth) cut--;
          if (line) { lines.push(line); line = ""; candidate = word; continue; }
          lines.push(candidate.slice(0, cut));
          candidate = candidate.slice(cut);
        }
        line = candidate;
      }
      if (line) lines.push(line);
      return lines.length ? lines : [""];
    };

    // Paleta da aplicacao: navy #002436, accent #EA4F24, verde #198754, vermelho #DC3545
    const NAVY = rgb(0, 36 / 255, 54 / 255);
    const ACCENT = rgb(234 / 255, 79 / 255, 36 / 255);
    const GREEN = rgb(25 / 255, 135 / 255, 84 / 255);
    const RED = rgb(220 / 255, 53 / 255, 69 / 255);
    const MUTED = rgb(87 / 255, 87 / 255, 86 / 255);
    const BORDER = rgb(222 / 255, 226 / 255, 230 / 255);
    const CARD = rgb(248 / 255, 249 / 255, 250 / 255);
    const TRACK = rgb(238 / 255, 240 / 255, 242 / 255);
    const WHITE = rgb(1, 1, 1);
    const pct = (n, t) => `${(t ? (n / t) * 100 : 0).toFixed(1).replace(".", ",")}%`;

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    const drawTitle = () => {
      page.drawRectangle({ x: 0, y: PAGE_H - 38, width: PAGE_W, height: 38, color: NAVY });
      page.drawRectangle({ x: 0, y: PAGE_H - 42, width: PAGE_W, height: 4, color: ACCENT });
      let logoW = 0;
      if (logoImage) {
        const logoH = 24;
        logoW = logoImage.width * logoH / logoImage.height;
        page.drawImage(logoImage, { x: MARGIN, y: PAGE_H - 38 + (38 - logoH)/2, width: logoW, height: logoH });
      }
      const titleText = "Relatorio de Chamados Encerrados";
      const titleWidth = bold.widthOfTextAtSize(titleText, 14);
      const titleX = Math.round((PAGE_W - titleWidth) / 2);
      page.drawText(titleText, { x: titleX, y: PAGE_H - 24, font: bold, size: 14, color: WHITE });
      const tag = safe(`PROJETO ${project}`);
      page.drawText(tag, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(tag, 9), y: PAGE_H - 22, font: bold, size: 9, color: rgb(0.85, 0.89, 0.92) });
      y = PAGE_H - 54;
      const periodo = (dateFrom || dateTo)
        ? `Periodo: ${dateFrom || "inicio"} ate ${dateTo || "hoje"}`
        : "Periodo: todos os chamados encerrados";
      const sub = `${periodo} | Status: Encerrado | Gerado em ${new Date().toLocaleString("pt-BR")}`;
      page.drawText(safe(sub), { x: MARGIN, y, font, size: 8, color: MUTED });
      y -= 16;
    };

    const expCount = (label) => dashboard.expirados.find((e) => e.label === label)?.count || 0;

    const drawKpis = () => {
      const kw = (CONTENT_W - 20) / 3;
      const cards = [
        { label: "Total de encerrados", value: dashboard.total, sub: "100%", color: NAVY },
        { label: "SLA expirado", value: expCount("Sim"), sub: pct(expCount("Sim"), dashboard.total), color: RED },
        { label: "SLA cumprido", value: expCount("Não"), sub: pct(expCount("Não"), dashboard.total), color: GREEN },
      ];
      cards.forEach((c, i) => {
        const x = MARGIN + i * (kw + 10);
        page.drawRectangle({ x, y: y - 44, width: kw, height: 44, color: CARD, borderColor: BORDER, borderWidth: 0.5 });
        page.drawRectangle({ x, y: y - 44, width: 4, height: 44, color: c.color });
        page.drawText(safe(c.label.toUpperCase()), { x: x + 12, y: y - 14, font: bold, size: 7, color: MUTED });
        page.drawText(String(c.value), { x: x + 12, y: y - 35, font: bold, size: 17, color: c.color });
        const s = String(c.sub);
        page.drawText(s, { x: x + kw - 10 - bold.widthOfTextAtSize(s, 9), y: y - 33, font: bold, size: 9, color: c.color });
      });
      y -= 56;
    };

    const drawBarPanel = (x, topY, panelW, title, entries, colorFn) => {
      page.drawText(safe(title), { x, y: topY, font: bold, size: 9, color: NAVY });
      const barX = x + 88;
      const barW = panelW - 88 - 54;
      let yy = topY - 15;
      const total = Math.max(1, dashboard.total);
      entries.slice(0, 6).forEach((e) => {
        page.drawText(safe(e.label).slice(0, 20), { x, y: yy, font, size: 7, color: MUTED });
        page.drawRectangle({ x: barX, y: yy - 1, width: barW, height: 8, color: TRACK });
        page.drawRectangle({ x: barX, y: yy - 1, width: Math.max(1, (e.count / total) * barW), height: 8, color: colorFn(e.label) });
        const lbl = `${pct(e.count, dashboard.total)} (${e.count})`;
        page.drawText(lbl, { x: x + panelW - bold.widthOfTextAtSize(lbl, 7), y: yy, font: bold, size: 7, color: NAVY });
        yy -= 13;
      });
      return topY - yy;
    };

    const prioColor = (label) => {
      const l = String(label).toLowerCase();
      if (l.includes("crít") || l.includes("crit")) return rgb(0.5, 0.11, 0.11);
      if (l.includes("alta")) return rgb(0.49, 0.18, 0.07);
      if (l.includes("média") || l.includes("media")) return rgb(0.12, 0.23, 0.54);
      if (l.includes("baixa")) return rgb(0.08, 0.33, 0.18);
      return ACCENT;
    };

    const drawSlaPanel = (x, topY, panelW) => {
      page.drawText("SLA / Expirados", { x, y: topY, font: bold, size: 9, color: NAVY });
      const sim = expCount("Sim");
      const nao = expCount("Não");
      const total = Math.max(1, dashboard.total);
      const barY = topY - 22;
      const wNao = (nao / total) * panelW;
      const wSim = (sim / total) * panelW;
      page.drawRectangle({ x, y: barY, width: panelW, height: 14, color: TRACK });
      page.drawRectangle({ x, y: barY, width: wNao, height: 14, color: GREEN });
      page.drawRectangle({ x: x + wNao, y: barY, width: wSim, height: 14, color: RED });
      let ly = barY - 12;
      page.drawRectangle({ x, y: ly, width: 8, height: 8, color: GREEN });
      page.drawText(safe(`Nao expirados: ${nao} (${pct(nao, dashboard.total)})`), { x: x + 12, y: ly + 1, font, size: 7, color: MUTED });
      ly -= 12;
      page.drawRectangle({ x, y: ly, width: 8, height: 8, color: RED });
      page.drawText(safe(`Expirados: ${sim} (${pct(sim, dashboard.total)})`), { x: x + 12, y: ly + 1, font: bold, size: 7, color: RED });
      return topY - ly + 6;
    };

    const drawDashboard = () => {
      const panelW = (CONTENT_W - 20) / 3;
      const rows = Math.max(2, Math.min(dashboard.porTipo.length, 6), Math.min(dashboard.porPrioridade.length, 6), Math.min(dashboard.porSistema?.length || 0, 6));
      const chartsH = 15 + rows * 13 + 6;
      const needed = 56 + 15 + chartsH + 10 + 50;
      if (y - needed < MARGIN + 40) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        drawTitle();
      }
      drawKpis();
      const chartTop = y;
      drawBarPanel(MARGIN, chartTop, panelW, "Por tipo", dashboard.porTipo, () => NAVY);
      drawBarPanel(MARGIN + panelW + 10, chartTop, panelW, "Por prioridade", dashboard.porPrioridade, prioColor);
      drawBarPanel(MARGIN + 2 * (panelW + 10), chartTop, panelW, "Por sistema", dashboard.porSistema || [], () => ACCENT);
      const afterBarsY = chartTop - chartsH - 8;
      drawSlaPanel(MARGIN, afterBarsY, CONTENT_W);
      y = afterBarsY - 50;
    };
    drawTitle();
    drawDashboard();

    const drawTableHeader = () => {
      page.drawRectangle({ x: MARGIN, y: y - 14, width: CONTENT_W, height: 15, color: NAVY });
      page.drawRectangle({ x: MARGIN, y: y - 16, width: CONTENT_W, height: 2, color: ACCENT });
      for (const c of COLUMNS) {
        page.drawText(c.label, { x: c.x + 2, y: y - 10, font: bold, size: 7, color: WHITE });
      }
      y -= 18;
    };
    drawTableHeader();

    const ROW_FONT = 7;
    const LINE_H = 8.5;
    const PAD_X = 2;
    const PAD_Y = 3;

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const values = [it.key, it.sistema, it.issuetype, it.sla, it.priority, it.summary, it.reporter, it.created, it.updated, it.resolutiondate, it.expirado];
      const cellLines = values.map((v, i) => wrap(v, font, ROW_FONT, COLUMNS[i].width - PAD_X * 2));
      const rowLines = Math.max(...cellLines.map((l) => l.length), 1);
      const rowH = rowLines * LINE_H + PAD_Y * 2;
      if (y - rowH < MARGIN + 12) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
        drawTableHeader();
      }
      if (idx % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - rowH, width: CONTENT_W, height: rowH, color: CARD });
      }
      cellLines.forEach((lines, i) => {
        lines.forEach((line, li) => {
          const color = i === 10 ? (it.expirado === "Sim" ? RED : GREEN) : rgb(0.12, 0.12, 0.12);
          page.drawText(line, { x: COLUMNS[i].x + PAD_X, y: y - PAD_Y - (li + 1) * LINE_H + 2, font, size: ROW_FONT, color });
        });
      });
      page.drawLine({ start: { x: MARGIN, y: y - rowH }, end: { x: MARGIN + CONTENT_W, y: y - rowH }, thickness: 0.3, color: BORDER });
      y -= rowH;
    }

    const pages = pdfDoc.getPages();
    pages.forEach((p, i) => {
      p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 22, color: NAVY });
      p.drawRectangle({ x: 0, y: 22, width: PAGE_W, height: 2, color: ACCENT });
      p.drawText(safe(`Chamados encerrados | Projeto ${project}`), { x: MARGIN, y: 8, font, size: 7, color: rgb(0.85, 0.89, 0.92) });
      const label = `Pagina ${i + 1} de ${pages.length}`;
      const w = font.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: PAGE_W - MARGIN - w, y: 8, font, size: 8, color: WHITE });
    });

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="chamados-encerrados-${project}-${Date.now()}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(err){ console.error("pdf encerrados error:",err); res.status(502).json({success:false,error:err.message}); }
});
// ============================================================================
// RELATORIO DE ATIVIDADE — Endpoints
// ============================================================================

app.get("/api/atividade/report", requireAuth, async (req, res) => {
  try {
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const searchQuery = (req.query.q || req.query.search || "").toString().trim();
    if (!dateFrom && !searchQuery) return res.status(400).json({ success: false, error: "Informe a data inicial ou um termo de busca no resumo" });
    const { items, jql } = await fetchActivityIssues(dateFrom, dateTo, 500, searchQuery);
    const dashboard = buildActivityDashboard(items);
    res.json({ success: true, total: items.length, dashboard, items, jql, dateFrom, dateTo, searchQuery });
  } catch (err) {
    console.error("atividade report error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get("/api/atividade/report/pdf", requireAuth, async (req, res) => {
  try {
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const searchQuery = (req.query.q || req.query.search || "").toString().trim();
    if (!dateFrom && !searchQuery) return res.status(400).json({ success: false, error: "Informe a data inicial ou um termo de busca no resumo" });
    const { items } = await fetchActivityIssues(dateFrom, dateTo, 500, searchQuery);
    const dashboard = buildActivityDashboard(items);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const safe = (v) => String(v ?? "").replace(/[^\u0020-\u00FF]/g, "").replace(/\s+/g, " ").trim();
    let logoImage = null;
    try {
      const logoBytes = await getLogoBytes();
      if (logoBytes) logoImage = await pdfDoc.embedPng(logoBytes);
    } catch {}

    const PAGE_W = 842, PAGE_H = 595, MARGIN = 30, CONTENT_W = PAGE_W - MARGIN * 2;

    // Paleta corporativa
    const NAVY = rgb(0, 36 / 255, 54 / 255);
    const ACCENT = rgb(234 / 255, 79 / 255, 36 / 255);
    const GREEN = rgb(25 / 255, 135 / 255, 84 / 255);
    const RED = rgb(220 / 255, 53 / 255, 69 / 255);
    const MUTED = rgb(87 / 255, 87 / 255, 86 / 255);
    const BORDER = rgb(222 / 255, 226 / 255, 230 / 255);
    const CARD = rgb(248 / 255, 249 / 255, 250 / 255);
    const TRACK = rgb(238 / 255, 240 / 255, 242 / 255);
    const WHITE = rgb(1, 1, 1);
    const DARK_GRAY = rgb(45 / 255, 45 / 255, 45 / 255);
    const SUCCESS_GREEN = rgb(38 / 255, 165 / 255, 107 / 255);
    const INFO_BLUE = rgb(29 / 255, 155 / 255, 240 / 255);
    const pct = (n, t) => `${(t ? (n / t) * 100 : 0).toFixed(1).replace(".", ",")}%`;

    const wrap = (text, fnt, size, maxWidth) => {
      const words = safe(text).split(" ").filter(Boolean);
      if (!words.length) return [""];
      const lines = [];
      let line = "";
      for (const word of words) {
        let candidate = line ? `${line} ${word}` : word;
        while (fnt.widthOfTextAtSize(candidate, size) > maxWidth) {
          let cut = candidate.length - 1;
          while (cut > 1 && fnt.widthOfTextAtSize(candidate.slice(0, cut), size) > maxWidth) cut--;
          if (line) { lines.push(line); line = ""; candidate = word; continue; }
          lines.push(candidate.slice(0, cut));
          candidate = candidate.slice(cut);
        }
        line = candidate;
      }
      if (line) lines.push(line);
      return lines.length ? lines : [""];
    };

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    const drawHeader = () => {
      // Linha superior dupla
      page.drawRectangle({ x: 0, y: PAGE_H - 44, width: PAGE_W, height: 44, color: NAVY });
      page.drawRectangle({ x: 0, y: PAGE_H - 48, width: PAGE_W, height: 4, color: ACCENT });

      // Logo (se disponível)
      if (logoImage) {
        const logoH = 28;
        const logoW = logoImage.width * logoH / logoImage.height;
        page.drawImage(logoImage, { x: MARGIN, y: PAGE_H - 44 + (44 - logoH) / 2, width: logoW, height: logoH });
      }

      // Título principal
      const titleText = "Relatório de Atividade - Chamados Criados";
      const titleWidth = bold.widthOfTextAtSize(titleText, 15);
      const titleX = Math.round((PAGE_W - titleWidth) / 2);
      page.drawText(titleText, { x: titleX, y: PAGE_H - 32, font: bold, size: 15, color: WHITE });

      // Tag do projeto
      page.drawText("PROJETO CSP", { x: PAGE_W - MARGIN - bold.widthOfTextAtSize("PROJETO CSP", 9), y: PAGE_H - 28, font: bold, size: 9, color: rgb(0.85, 0.89, 0.92) });

      // Linha de metadata
      y = PAGE_H - 58;
      const periodo = safe(`Período: ${dateFrom || "início"} até ${dateTo || "hoje"}`);
      page.drawText(periodo, { x: MARGIN, y, font, size: 8, color: MUTED });
      page.drawText(`Total de chamados: ${dashboard.total} | Gerado em ${new Date().toLocaleString("pt-BR")}`, { x: MARGIN + 120, y, font, size: 8, color: MUTED });
      y -= 16;
    };

    const drawKpis = () => {
      const kw = (CONTENT_W - 20) / 4;
      const cards = [
        { label: "Total", value: dashboard.total, sub: "chamados", color: NAVY },
        { label: "Abertos", value: dashboard.porStatus?.find(s => s.label.toLowerCase().includes('aberto') || s.label.toLowerCase().includes('open'))?.count || 0, sub: "registros", color: ACCENT },
        { label: "Responsáveis", value: dashboard.porResponsavel.length, sub: "pessoas", color: rgb(0.12, 0.23, 0.54) },
        { label: "Prioridades", value: dashboard.porPrioridade.length, sub: "níveis", color: GREEN },
      ];
      cards.forEach((c, i) => {
        const x = MARGIN + i * (kw + 10);
        page.drawRectangle({ x, y: y - 48, width: kw, height: 48, color: CARD, borderColor: BORDER, borderWidth: 0.75 });
        page.drawRectangle({ x, y: y - 48, width: 6, height: 48, color: c.color });
        page.drawText(safe(c.label.toUpperCase()), { x: x + 14, y: y - 16, font: bold, size: 7, color: MUTED });
        page.drawText(String(c.value), { x: x + 14, y: y - 38, font: bold, size: 20, color: c.color });
        const s = String(c.sub);
        page.drawText(s, { x: x + kw - 14 - bold.widthOfTextAtSize(s, 9), y: y - 36, font: bold, size: 9, color: c.color });
      });
      y -= 62;
    };

    const drawBarPanel = (x, topY, panelW, title, entries, colorFn) => {
      page.drawText(safe(title), { x, y: topY, font: bold, size: 9, color: NAVY });
      const barX = x + 80;
      const barW = panelW - 80 - 40;
      let yy = topY - 15;
      const total = Math.max(1, dashboard.total);
      entries.slice(0, 6).forEach((e) => {
        page.drawText(safe(e.label).slice(0, 20), { x, y: yy, font, size: 7, color: MUTED });
        page.drawRectangle({ x: barX, y: yy - 1, width: barW, height: 8, color: TRACK });
        page.drawRectangle({ x: barX, y: yy - 1, width: Math.max(1, (e.count / total) * barW), height: 8, color: colorFn(e.label) });
        const lbl = `${pct(e.count, dashboard.total)} (${e.count})`;
        page.drawText(lbl, { x: x + panelW - 30 - bold.widthOfTextAtSize(lbl, 7), y: yy, font: bold, size: 7, color: NAVY });
        yy -= 13;
      });
      return topY - yy;
    };

    const responsavelColor = (label) => {
      const l = String(label).toLowerCase();
      if (l.includes("fredson")) return NAVY;
      if (l.includes("adriana")) return ACCENT;
      if (l.includes("amanda")) return GREEN;
      return rgb(0.12, 0.23, 0.54);
    };

    const drawResumoPorResponsavel = (x, topY, panelW) => {
      page.drawText("Resumo por Responsável", { x, y: topY, font: bold, size: 9, color: NAVY });
      let yy = topY - 15;
      const total = Math.max(1, dashboard.total);
      dashboard.porResponsavel.slice(0, 8).forEach((e) => {
        const nomeCurto = safe(e.label).slice(0, 24);
        page.drawText(nomeCurto, { x, y: yy, font, size: 7, color: MUTED });
        const barW = panelW - 85;
        page.drawRectangle({ x: x + 80, y: yy - 1, width: barW, height: 8, color: TRACK });
        page.drawRectangle({ x: x + 80, y: yy - 1, width: Math.max(1, (e.count / total) * barW), height: 8, color: responsavelColor(e.label) });
        const lbl = `${pct(e.count, dashboard.total)} (${e.count})`;
        page.drawText(lbl, { x: x + panelW - 25 - bold.widthOfTextAtSize(lbl, 7), y: yy, font: bold, size: 7, color: NAVY });
        yy -= 13;
      });
      return topY - yy;
    };

    const drawDashboard = () => {
      const panelW = (CONTENT_W - 20) / 2;
      const rows = Math.max(2, Math.min(dashboard.porStatus.length, 6), Math.min(dashboard.porPrioridade.length, 6));
      const chartsH = 15 + rows * 13 + 6;
      const resumoH = 15 + Math.min(dashboard.porResponsavel.length, 8) * 13 + 6;
      const needed = 62 + 15 + Math.max(chartsH, resumoH) + 10 + 50;
      if (y - needed < MARGIN + 50) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        drawHeader();
      }
      drawKpis();
      const chartTop = y;
      const usedLeft = drawBarPanel(MARGIN, chartTop, panelW, "Por Status", dashboard.porStatus, () => NAVY);
      const usedRight = drawBarPanel(MARGIN + panelW + 10, chartTop, panelW, "Por Prioridade", dashboard.porPrioridade, (label) => {
        const l = String(label).toLowerCase();
        if (l.includes("alta")) return RED;
        if (l.includes("média") || l.includes("media")) return rgb(29 / 255, 155 / 255, 240 / 255);
        if (l.includes("baixa")) return GREEN;
        return ACCENT;
      });
      const afterBarsY = chartTop - Math.max(usedLeft, usedRight) - 8;
      const usedResumo = drawResumoPorResponsavel(MARGIN, afterBarsY, CONTENT_W);
      y = afterBarsY - usedResumo - 20;
    };

    drawHeader();
    drawDashboard();

    // Tabela detalhada dos chamados
    const TABLE_COLUMNS = [
      { label: "Chamado", width: 70 },
      { label: "Resumo", width: 220 },
      { label: "Status", width: 70 },
      { label: "Prioridade", width: 70 },
      { label: "Responsável", width: 120 },
      { label: "Criado", width: 80 },
    ];
    let colX = MARGIN;
    for (const c of TABLE_COLUMNS) { c.x = colX; colX += c.width; }

    const drawTableHeader = () => {
      page.drawRectangle({ x: MARGIN, y: y - 15, width: CONTENT_W, height: 16, color: NAVY });
      page.drawRectangle({ x: MARGIN, y: y - 17, width: CONTENT_W, height: 2, color: ACCENT });
      for (const c of TABLE_COLUMNS) {
        page.drawText(c.label, { x: c.x + 3, y: y - 11, font: bold, size: 7, color: WHITE });
      }
      y -= 20;
    };

    const ROW_FONT = 7;
    const LINE_H = 9;
    const PAD_X = 2;
    const PAD_Y = 3;

    drawTableHeader();

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const values = [it.key, it.summary, it.status, it.priority, it.assignee, it.created];
      const cellLines = values.map((v, i) => wrap(v, font, ROW_FONT, TABLE_COLUMNS[i].width - PAD_X * 2));
      const rowLines = Math.max(...cellLines.map((l) => l.length), 1);
      const rowH = rowLines * LINE_H + PAD_Y * 2;
      if (y - rowH < MARGIN + 20) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
        drawTableHeader();
      }
      if (idx % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - rowH, width: CONTENT_W, height: rowH, color: CARD });
      }
      cellLines.forEach((lines, i) => {
        lines.forEach((line, li) => {
          page.drawText(line, { x: TABLE_COLUMNS[i].x + PAD_X, y: y - PAD_Y - (li + 1) * LINE_H + 2, font, size: ROW_FONT, color: rgb(0.12, 0.12, 0.12) });
        });
      });
      page.drawLine({ start: { x: MARGIN, y: y - rowH }, end: { x: MARGIN + CONTENT_W, y: y - rowH }, thickness: 0.3, color: BORDER });
      y -= rowH;
    }

    // Rodape em cada pagina
    const pages = pdfDoc.getPages();
    pages.forEach((p, i) => {
      p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 32, color: NAVY });
      p.drawRectangle({ x: 0, y: 2, width: PAGE_W, height: 2, color: ACCENT });
      p.drawText(safe(`Relatório de Atividade | Projeto CSP | ${dateFrom} até ${dateTo || "hoje"}${searchQuery ? " | Resumo: " + searchQuery : ""}`), { x: MARGIN, y: 8, font, size: 7, color: rgb(0.85, 0.89, 0.92) });
      p.drawText(safe(`Página ${i + 1} de ${pages.length}`), { x: PAGE_W - MARGIN - 60, y: 8, font: bold, size: 8, color: WHITE });
      p.drawText(safe(`Gerado em: ${new Date().toLocaleString("pt-BR")}`), { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(`Gerado em: ${new Date().toLocaleString("pt-BR")}`, 7), y: 28, font, size: 7, color: rgb(0.85, 0.89, 0.92) });
    });

    const pdfBytes = await pdfDoc.save();
    const fileName = `atividade-csp-${dateFrom}-${dateTo || "hoje"}${searchQuery ? "-" + searchQuery.replace(/\s+/g,"_") : ""}-${Date.now()}.pdf`.replace(/\s+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("pdf atividade error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CONTROLE DE ATIVIDADES + WHATSAPP BUSINESS
// ============================================================================

try {
  initActivityControlDB();
  console.log("Banco de dados de Controle de Atividades inicializado");
} catch (err) {
  console.error("Erro ao inicializar banco de Controle de Atividades:", err.message);
}

// Listar atividades
app.get("/api/activity-control", requireAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100", 10);
    const offset = parseInt(req.query.offset || "0", 10);
    const items = listActivities(limit, offset);
    const total = countActivities();
    res.json({ success: true, total, items });
  } catch (err) {
    console.error("activity control list error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Relatório de Atividades (Controle) - JSON
app.get("/api/activity-control/report", requireAuth, (req, res) => {
  try {
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const responsavel = (req.query.responsavel || "").toString().trim();
    if (!dateFrom) return res.status(400).json({ success: false, error: "Data inicial é obrigatória" });
    const items = listActivitiesFiltered(dateFrom, dateTo, responsavel);
    res.json({ success: true, total: items.length, items, dateFrom, dateTo, responsavel });
  } catch (err) {
    console.error("activity control report error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Relatório de Atividades (Controle) - PDF com Dashboard
app.get("/api/activity-control/report/pdf", requireAuth, async (req, res) => {
  try {
    const dateFrom = (req.query.dateFrom || "").toString().trim();
    const dateTo = (req.query.dateTo || "").toString().trim();
    const responsavel = (req.query.responsavel || "").toString().trim();
    if (!dateFrom) return res.status(400).json({ success: false, error: "Data inicial é obrigatória" });

    const items = listActivitiesFiltered(dateFrom, dateTo, responsavel);

    // ===== PDF Generation =====
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const safe = (v) => String(v ?? "").replace(/[^\u0020-\u00FF]/g, "").replace(/\s+/g, " ").trim();

    const PAGE_W = 842, PAGE_H = 595, MARGIN = 35, CONTENT_W = PAGE_W - 2 * MARGIN;
    const NAVY = rgb(0.0, 0.14, 0.21);
    const ACCENT = rgb(0.0, 0.45, 0.75);
    const GREEN = rgb(0.1, 0.55, 0.25);
    const RED = rgb(0.8, 0.1, 0.1);
    const ORANGE = rgb(0.9, 0.55, 0.0);
    const PURPLE = rgb(0.5, 0.2, 0.7);
    const MUTED = rgb(0.4, 0.4, 0.4);
    const BORDER = rgb(0.82, 0.82, 0.82);
    const CARD = rgb(0.96, 0.96, 0.96);
    const WHITE = rgb(1, 1, 1);
    const TRACK = rgb(0.88, 0.88, 0.88);
    const LIGHT_BLUE = rgb(0.9, 0.95, 1.0);

    const pct = (n, total) => total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "0%";

    const countBy = (arr, key) => {
      const map = {};
      arr.forEach(item => {
        const v = String(item[key] || "Não informado").trim();
        map[v] = (map[v] || 0) + 1;
      });
      return Object.entries(map).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    };

    const wrapText = (text, maxWidth, fontSize) => {
      const words = String(text || "").split(" ");
      const lines = [];
      let currentLine = "";
      words.forEach(word => {
        const testLine = currentLine ? currentLine + " " + word : word;
        if (font.widthOfTextAtSize(testLine, fontSize) <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      });
      if (currentLine) lines.push(currentLine);
      return lines.length > 0 ? lines : [""];
    };

    const drawBarPanel = (x, topY, panelW, title, entries, total, colors) => {
      page.drawText(safe(title), { x, y: topY, font: bold, size: 10, color: NAVY });
      let yy = topY - 16;
      const barW = panelW - 4;
      entries.slice(0, 8).forEach((e, i) => {
        const fullLabel = safe(e.label);
        const labelFontSize = 7;
        const labelLines = [];
        let currentLine = "";
        fullLabel.split(" ").forEach(word => {
          const testLine = currentLine ? currentLine + " " + word : word;
          if (font.widthOfTextAtSize(testLine, labelFontSize) <= panelW - 4) {
            currentLine = testLine;
          } else {
            if (currentLine) labelLines.push(currentLine);
            currentLine = word;
          }
        });
        if (currentLine) labelLines.push(currentLine);
        if (labelLines.length === 0) labelLines.push("");

        labelLines.forEach((line, li) => {
          page.drawText(line, { x, y: yy - li * 9, font, size: labelFontSize, color: MUTED });
        });
        const labelH = labelLines.length * 9;

        const barY = yy - labelH - 1;
        page.drawRectangle({ x, y: barY - 1, width: barW, height: 7, color: TRACK });
        const barFillW = Math.max(1, (e.count / Math.max(1, total)) * barW);
        const barColor = colors ? colors(e.label) : ACCENT;
        page.drawRectangle({ x, y: barY - 1, width: barFillW, height: 7, color: barColor });

        const val = `${e.count} (${pct(e.count, total)})`;
        page.drawText(val, { x: x + barW - font.widthOfTextAtSize(val, 6) + 2, y: barY - 1, font, size: 6, color: MUTED });

        yy -= labelH + 10;
      });
      return yy;
    };

    // ===== Page 1: Dashboard =====
    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    // Header banner
    page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: NAVY });
    page.drawRectangle({ x: 0, y: PAGE_H - 72, width: PAGE_W, height: 2, color: ACCENT });
    page.drawText(safe("Relatório de Atividades - Controle"), { x: MARGIN, y: PAGE_H - 38, font: bold, size: 18, color: WHITE });
    page.drawText(safe("Relatório Completo de Todas as Atividades Registradas"), { x: MARGIN, y: PAGE_H - 55, font, size: 10, color: rgb(0.85, 0.89, 0.92) });
    page.drawText(safe(`Período: ${dateFrom} até ${dateTo || "hoje"}${responsavel ? "  |  Responsável: " + responsavel : ""}`), { x: MARGIN, y: PAGE_H - 70, font, size: 9, color: rgb(0.85, 0.89, 0.92) });

    y = PAGE_H - 90;

    // ===== KPIs =====
    const total = items.length;
    const enviados = items.filter(i => i.whatsapp_enviado === 1).length;
    const pendentes = total - enviados;
    const reenviados = items.filter(i => i.status === "reenviado").length;
    const editados = items.filter(i => i.status === "editada").length;
    const registrados = items.filter(i => i.status === "registrado" || !i.status).length;

    const kpis = [
      { label: "Total Atividades", value: total, color: NAVY },
      { label: "WhatsApp Enviados", value: enviados, color: GREEN },
      { label: "Pendentes Envio", value: pendentes, color: ORANGE },
      { label: "Reenviados", value: reenviados, color: ACCENT },
      { label: "Editados", value: editados, color: PURPLE },
    ];

    const kpiW = (CONTENT_W - 40) / 5;
    kpis.forEach((k, i) => {
      const x = MARGIN + i * (kpiW + 10);
      page.drawRectangle({ x, y: y - 50, width: kpiW, height: 55, color: CARD, borderColor: BORDER, borderWidth: 1 });
      // Label (wrapped to 2 lines if needed)
      const labelLines = wrapText(k.label, kpiW - 8, 5.5);
      labelLines.forEach((line, li) => {
        page.drawText(safe(line), { x: x + 4, y: y - 10 - li * 7, font, size: 5.5, color: MUTED });
      });
      page.drawText(String(k.value), { x: x + 4, y: y - 40, font: bold, size: 18, color: k.color });
      const pctVal = total > 0 ? ((k.value / total) * 100).toFixed(1) + "%" : "0%";
      page.drawText(pctVal, { x: x + kpiW - font.widthOfTextAtSize(pctVal, 6) - 4, y: y - 40, font, size: 6, color: MUTED });
    });

    y -= 65;

    // ===== Dashboard: Bar Charts =====
    const porStatus = countBy(items, "status");
    const porResponsavel = countBy(items, "responsavel");
    const porTipo = countBy(items, "tipo");
    const porPessoa = countBy(items, "pessoa");
    const porCliente = countBy(items, "cliente");

    const statusColors = (label) => {
      const l = String(label).toLowerCase();
      if (l.includes("reenviado")) return ACCENT;
      if (l.includes("editada")) return PURPLE;
      if (l.includes("registrado")) return GREEN;
      return NAVY;
    };
    const respColors = (label) => {
      const l = String(label).toLowerCase();
      if (l.includes("fredson")) return GREEN;
      if (l.includes("adriana")) return RED;
      if (l.includes("amanda")) return ORANGE;
      return NAVY;
    };

    const halfW = (CONTENT_W - 10) / 2;
    const leftX = MARGIN;
    const rightX = MARGIN + halfW + 10;

    let leftY = y;
    leftY = drawBarPanel(leftX, leftY, halfW, "Por Status", porStatus, total, statusColors) - 8;
    leftY = drawBarPanel(leftX, leftY, halfW, "Por Tipo", porTipo, total, null) - 8;
    leftY = drawBarPanel(leftX, leftY, halfW, "Por Cliente", porCliente, total, null) - 8;

    let rightY = y;
    rightY = drawBarPanel(rightX, rightY, halfW, "Por Responsável", porResponsavel, total, respColors) - 8;
    rightY = drawBarPanel(rightX, rightY, halfW, "Por Pessoa", porPessoa, total, null) - 8;

    // Additional stats
    const uniquePessoas = new Set(items.map(i => i.pessoa).filter(Boolean)).size;
    const uniqueClientes = new Set(items.map(i => i.cliente).filter(Boolean)).size;
    const uniqueTipos = new Set(items.map(i => i.tipo).filter(Boolean)).size;
    const uniqueResponsaveis = new Set(items.map(i => i.responsavel).filter(Boolean)).size;
    const waEnviadosCount = items.filter(i => i.whatsapp_enviado === 1).length;
    const waPendentesCount = total - waEnviadosCount;

    const statsY = Math.min(leftY, rightY) - 10;
    page.drawText(safe("Estatísticas Adicionais"), { x: MARGIN, y: statsY, font: bold, size: 10, color: NAVY });
    const stats = [
      { label: "Pessoas únicas atendidas", value: uniquePessoas },
      { label: "Clientes únicos", value: uniqueClientes },
      { label: "Tipos de atividade", value: uniqueTipos },
      { label: "Responsáveis", value: uniqueResponsaveis },
      { label: "WhatsApp Enviados", value: waEnviadosCount },
      { label: "WhatsApp Pendentes", value: waPendentesCount },
      { label: "Média de atividades por dia", value: total > 0 ? (total / Math.max(1, new Set(items.map(i => i.data_registro)).size)).toFixed(1) : "0" },
    ];
    let sy = statsY - 14;
    stats.forEach(s => {
      page.drawText(safe(s.label), { x: MARGIN, y: sy, font, size: 7, color: MUTED });
      const val = String(s.value);
      page.drawText(val, { x: MARGIN + 260, y: sy, font: bold, size: 8, color: NAVY });
      sy -= 12;
    });

    // ===== Page 2: WhatsApp Sending History =====
    const waEnviados = items.filter(i => i.whatsapp_enviado === 1).sort((a, b) => (a.whatsapp_enviado_em || "").localeCompare(b.whatsapp_enviado_em || ""));
    if (waEnviados.length > 0) {
      page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;

      page.drawRectangle({ x: 0, y: PAGE_H - 40, width: PAGE_W, height: 40, color: NAVY });
      page.drawRectangle({ x: 0, y: PAGE_H - 42, width: PAGE_W, height: 2, color: ACCENT });
      page.drawText(safe("Histórico de Envios WhatsApp"), { x: MARGIN, y: PAGE_H - 28, font: bold, size: 14, color: WHITE });
      page.drawText(safe(`${waEnviados.length} envios realizados | ${dateFrom} até ${dateTo || "hoje"}`), { x: MARGIN, y: PAGE_H - 42, font, size: 8, color: rgb(0.85, 0.89, 0.92) });

      y = PAGE_H - 60;

      const waCols = [
        { label: "Data Envio", x: MARGIN, w: 130 },
        { label: "Título", x: MARGIN + 135, w: 260 },
        { label: "Responsável", x: MARGIN + 400, w: 120 },
        { label: "Pessoa", x: MARGIN + 525, w: 120 },
        { label: "Nº WhatsApp", x: MARGIN + 650, w: 120 },
      ];
      waCols.forEach(c => {
        page.drawText(safe(c.label), { x: c.x, y, font: bold, size: 8, color: NAVY });
      });
      y -= 14;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: BORDER });
      y -= 6;

      waEnviados.forEach((item, idx) => {
        if (y < MARGIN + 30) {
          page = pdfDoc.addPage([PAGE_W, PAGE_H]);
          y = PAGE_H - MARGIN;
          page.drawRectangle({ x: 0, y: PAGE_H - 40, width: PAGE_W, height: 40, color: NAVY });
          page.drawRectangle({ x: 0, y: PAGE_H - 42, width: PAGE_W, height: 2, color: ACCENT });
          page.drawText(safe("Histórico de Envios WhatsApp (cont.)"), { x: MARGIN, y: PAGE_H - 28, font: bold, size: 14, color: WHITE });
          y = PAGE_H - 60;
          waCols.forEach(c => {
            page.drawText(safe(c.label), { x: c.x, y, font: bold, size: 8, color: NAVY });
          });
          y -= 14;
          page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: BORDER });
          y -= 6;
        }

        const rowH = 24;
        if (idx % 2 === 0) {
          page.drawRectangle({ x: MARGIN, y: y - rowH + 4, width: CONTENT_W, height: rowH, color: CARD });
        }

        const envioDate = item.whatsapp_enviado_em ? item.whatsapp_enviado_em.split("T")[0] : (item.data_registro || "");
        const envioTime = item.whatsapp_enviado_em ? (item.whatsapp_enviado_em.split("T")[1] || "").split(".")[0] : "";
        page.drawText(safe(`${envioDate} ${envioTime}`), { x: MARGIN, y: y - 2, font, size: 7, color: MUTED });
        page.drawText(safe((item.titulo || "").slice(0, 48)), { x: MARGIN + 135, y: y - 2, font, size: 7, color: rgb(0.2, 0.2, 0.2) });
        page.drawText(safe((item.responsavel || "").slice(0, 18)), { x: MARGIN + 400, y: y - 2, font, size: 7, color: rgb(0.2, 0.2, 0.2) });
        page.drawText(safe((item.pessoa || "").slice(0, 18)), { x: MARGIN + 525, y: y - 2, font, size: 7, color: rgb(0.2, 0.2, 0.2) });
        page.drawText(safe((item.whatsapp_numero || "").slice(0, 18)), { x: MARGIN + 650, y: y - 2, font, size: 7, color: MUTED });

        y -= rowH;
      });
    }

    // ===== Page 3+: Detailed Cards =====
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;

    page.drawRectangle({ x: 0, y: PAGE_H - 40, width: PAGE_W, height: 40, color: NAVY });
    page.drawRectangle({ x: 0, y: PAGE_H - 42, width: PAGE_W, height: 2, color: ACCENT });
    page.drawText(safe("Detalhamento Completo das Atividades"), { x: MARGIN, y: PAGE_H - 28, font: bold, size: 14, color: WHITE });
    page.drawText(safe(`Total: ${total} atividades | ${dateFrom} até ${dateTo || "hoje"}${responsavel ? " | Responsável: " + responsavel : ""}`), { x: MARGIN, y: PAGE_H - 42, font, size: 8, color: rgb(0.85, 0.89, 0.92) });

    y = PAGE_H - 60;

    items.forEach((item, idx) => {
      const tituloLines = wrapText(item.titulo || "", CONTENT_W - 20, 9);
      const descLines = item.descricao ? wrapText(item.descricao, CONTENT_W - 20, 7.5) : [];
      const cardH = 52 + (tituloLines.length - 1) * 11 + (descLines.length > 0 ? descLines.length * 9 + 4 : 0) + (item.whatsapp_numero ? 10 : 0) + 20;

      if (y - cardH < MARGIN + 30) {
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
        page.drawRectangle({ x: 0, y: PAGE_H - 40, width: PAGE_W, height: 40, color: NAVY });
        page.drawRectangle({ x: 0, y: PAGE_H - 42, width: PAGE_W, height: 2, color: ACCENT });
        page.drawText(safe("Detalhamento Completo das Atividades (cont.)"), { x: MARGIN, y: PAGE_H - 28, font: bold, size: 14, color: WHITE });
        y = PAGE_H - 60;
      }

      // Card background
      page.drawRectangle({ x: MARGIN, y: y - cardH, width: CONTENT_W, height: cardH, color: idx % 2 === 0 ? WHITE : CARD, borderColor: BORDER, borderWidth: 0.5 });

      let ty = y - 14;
      // Title
      tituloLines.forEach((line, li) => {
        page.drawText(safe(line), { x: MARGIN + 8, y: ty - li * 11, font: bold, size: 9, color: NAVY });
      });
      ty -= tituloLines.length * 11 + 2;

      // Info row 1: Responsável | Pessoa | Cliente
      const info1 = [
        item.responsavel ? `Responsável: ${item.responsavel}` : "",
        item.pessoa ? `Pessoa: ${item.pessoa}` : "",
        item.cliente ? `Cliente: ${item.cliente}` : "",
      ].filter(Boolean).join("  |  ");
      if (info1) {
        page.drawText(safe(info1), { x: MARGIN + 8, y: ty, font, size: 8, color: rgb(0.2, 0.2, 0.2) });
        ty -= 11;
      }

      // Info row 2: Tipo | Data | Status | WhatsApp
      const waStatus = item.status === "reenviado" ? "Reenviado" : (item.whatsapp_enviado ? "Enviado" : "Pendente");
      const info2 = [
        item.tipo ? `Tipo: ${item.tipo}` : "",
        item.data_registro ? `Data: ${item.data_registro}` : "",
        `Status: ${item.status || "registrado"}`,
        `WhatsApp: ${waStatus}`,
      ].filter(Boolean).join("  |  ");
      page.drawText(safe(info2), { x: MARGIN + 8, y: ty, font, size: 8, color: rgb(0.2, 0.2, 0.2) });
      ty -= 11;

      // Description
      if (descLines.length > 0) {
        descLines.forEach((line, li) => {
          page.drawText(safe(line), { x: MARGIN + 8, y: ty - li * 9, font, size: 7.5, color: MUTED });
        });
        ty -= descLines.length * 9 + 2;
      }

      // WhatsApp number
      if (item.whatsapp_numero) {
        page.drawText(safe(`Nº WhatsApp: ${item.whatsapp_numero}`), { x: MARGIN + 8, y: ty, font, size: 7.5, color: MUTED });
        ty -= 9;
      }

      // Timestamps
      const tsLines = [];
      if (item.created_at) tsLines.push(`Criado: ${item.created_at}`);
      if (item.updated_at && item.updated_at !== item.created_at) tsLines.push(`Atualizado: ${item.updated_at}`);
      if (item.whatsapp_enviado_em) tsLines.push(`WA enviado: ${item.whatsapp_enviado_em}`);
      if (tsLines.length > 0) {
        page.drawText(safe(tsLines.join("  |  ")), { x: MARGIN + 8, y: ty, font, size: 6.5, color: rgb(0.6, 0.6, 0.6) });
        ty -= 9;
      }

      y -= cardH + 6;
    });

    // Footer on all pages
    const pages = pdfDoc.getPages();
    pages.forEach((p, i) => {
      p.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 24, color: NAVY });
      p.drawRectangle({ x: 0, y: 24, width: PAGE_W, height: 2, color: ACCENT });
      p.drawText(safe(`Relatório de Atividades - Controle | ${dateFrom} até ${dateTo || "hoje"}`), { x: MARGIN, y: 8, font, size: 7, color: rgb(0.85, 0.89, 0.92) });
      const label = `Página ${i + 1} de ${pages.length}`;
      p.drawText(label, { x: PAGE_W - MARGIN - bold.widthOfTextAtSize(label, 8), y: 8, font: bold, size: 8, color: WHITE });
    });

    const pdfBytes = await pdfDoc.save();
    const fileName = `relatorio-atividades-${dateFrom}-${dateTo || "hoje"}${responsavel ? "-" + responsavel : ""}-${Date.now()}.pdf`.replace(/\\s+/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("activity control report pdf error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});


// Obter atividade por ID
app.get("/api/activity-control/:id", requireAuth, (req, res) => {
  try {
    const item = getActivity(req.params.id);
    if (!item) return res.status(404).json({ success: false, error: "Atividade não encontrada" });
    res.json({ success: true, item });
  } catch (err) {
    console.error("activity control get error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Criar atividade
app.post("/api/activity-control", requireAuth, (req, res) => {
  try {
    const { titulo, descricao, responsavel, pessoa, cliente, tipo, data_registro, whatsapp_numero } = req.body || {};
    if (!titulo) return res.status(400).json({ success: false, error: "Título é obrigatório" });
    const item = createActivity({ titulo, descricao, responsavel, pessoa, cliente, tipo, data_registro, whatsapp_numero });
    res.json({ success: true, item });
  } catch (err) {
    console.error("activity control create error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Atualizar atividade
app.put("/api/activity-control/:id", requireAuth, (req, res) => {
  try {
    const existing = getActivity(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: "Atividade não encontrada" });

    // Se a atividade já foi enviada via WhatsApp e está sendo editada,
    // marcar como "editada" e resetar flag de envio para que seja reenviada
    const wasSent = existing.whatsapp_enviado === 1;
    const body = { ...req.body };
    if (wasSent) {
      body.status = "editada";
      body.whatsapp_enviado = 0;
    }

    const item = updateActivity(req.params.id, body);
    res.json({ success: true, item, wasSent, needsResend: wasSent });
  } catch (err) {
    console.error("activity control update error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Deletar atividade
app.delete("/api/activity-control/:id", requireAuth, (req, res) => {
  try {
    const result = deleteActivity(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("activity control delete error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Gerar texto para WhatsApp Business
app.post("/api/activity-control/:id/whatsapp", requireAuth, (req, res) => {
  try {
    const item = getActivity(req.params.id);
    if (!item) return res.status(404).json({ success: false, error: "Atividade não encontrada" });
    const { whatsapp_numero } = req.body || {};
    const numero = whatsapp_numero || item.whatsapp_numero || "";
    if (!numero) return res.status(400).json({ success: false, error: "Número do WhatsApp é obrigatório" });

    // Montar texto da mensagem - cada atividade em uma linha
    const parts = [];
    parts.push(`📋 *Controle de Atividades*`);
    parts.push(``);
    const activityLine = [
      `*${item.titulo}*`,
      item.descricao ? `Desc: ${item.descricao}` : "",
      item.responsavel ? `Resp: ${item.responsavel}` : "",
      item.pessoa ? `Pessoa: ${item.pessoa}` : "",
      item.cliente ? `Cliente: ${item.cliente}` : "",
      item.tipo ? `Tipo: ${item.tipo}` : "",
      item.data_registro ? `Data: ${item.data_registro}` : "",
      item.status ? `Status: ${item.status}` : ""
    ].filter(Boolean).join(" | ");
    parts.push(activityLine);
    parts.push(``);
    parts.push(`_Registrado via Jira Tocantins App_`);

    const texto = parts.join("\\n");
    const encoded = encodeURIComponent(texto);
    const waLink = `https://wa.me/${numero.replace(/\\D/g, "")}?text=${encoded}`;

    // Marcar como enviado - se estava 'editada', marcar como 'reenviado'
    const isResend = item.status === "editada";
    markWhatsappSent(item.id, numero, isResend);

    res.json({ success: true, item: getActivity(item.id), texto, waLink, resent: isResend });
  } catch (err) {
    console.error("activity control whatsapp error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Enviar WhatsApp em massa (batch) para várias atividades
app.post("/api/activity-control/batch-whatsapp", requireAuth, (req, res) => {
  try {
    const { ids, whatsapp_numero } = req.body || {};
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "IDs das atividades são obrigatórios" });
    }

    // Buscar todas as atividades selecionadas
    const items = ids.map(id => getActivity(id)).filter(Boolean);
    if (items.length === 0) {
      return res.status(404).json({ success: false, error: "Nenhuma atividade encontrada" });
    }

    // Determinar número do WhatsApp (usar o primeiro item que tiver número, ou o fornecido)
    const numero = whatsapp_numero || items.find(it => it.whatsapp_numero)?.whatsapp_numero || "";
    if (!numero) {
      return res.status(400).json({ success: false, error: "Número do WhatsApp é obrigatório" });
    }

    // Montar texto combinado com todas as atividades, incluindo datas
    const lines = [
      `📋 *Controle de Atividades - Envio em Massa*`,
      ``,
      `Total de atividades: ${items.length}`,
      ``
    ];

    items.forEach((item, idx) => {
      const activityLine = [
        `${idx + 1}. ${item.titulo}`,
        item.descricao ? `Desc: ${item.descricao}` : "",
        item.responsavel ? `Resp: ${item.responsavel}` : "",
        item.pessoa ? `Pessoa: ${item.pessoa}` : "",
        item.cliente ? `Cliente: ${item.cliente}` : "",
        item.tipo ? `Tipo: ${item.tipo}` : "",
        item.data_registro ? `Data: ${item.data_registro}` : "",
        item.status ? `Status: ${item.status}` : ""
      ].filter(Boolean).join(" | ");
      lines.push(activityLine);
    });

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`_Registrado via Jira Tocantins App_`);

    const texto = lines.join("\\n");
    const encoded = encodeURIComponent(texto);
    const waLink = `https://wa.me/${numero.replace(/\\D/g, "")}?text=${encoded}`;

    // Marcar todas como enviadas - se estava 'editada', marcar como 'reenviado'
    const resentIds = [];
    items.forEach(item => {
      try {
        const isResend = item.status === "editada";
        markWhatsappSent(item.id, numero, isResend);
        if (isResend) resentIds.push(item.id);
      } catch (e) {
        console.error(`Erro ao marcar atividade ${item.id} como enviada:`, e.message);
      }
    });

    res.json({ success: true, total: items.length, texto, waLink, items: items.map(it => getActivity(it.id)), resentCount: resentIds.length, resentIds });
  } catch (err) {
    console.error("activity control batch whatsapp error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Listar atividades pendentes de WhatsApp
app.get("/api/activity-control/pending-whatsapp", requireAuth, (req, res) => {
  try {
    const items = getPendingWhatsapp();
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    console.error("activity control pending whatsapp error:", err);
    res.status(502).json({ success: false, error: err.message });
  }
});
try {
  initNtpDocumentsDB();
  console.log("Banco de dados NTP inicializado");
} catch (err) {
  console.error("Erro ao inicializar banco NTP:", err.message);
}

// Inicializar banco de dados de Controle de Atividades
try {
  initActivityControlDB();
  console.log("Banco de dados de Controle de Atividades inicializado");
} catch (err) {
  console.error("Erro ao inicializar banco de Controle de Atividades:", err.message);
}

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
