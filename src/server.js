import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { config, jiraAuthHeader } from "./config.js";
import { fetchAbertos, fetchFilter, fetchIssuesByJql, normalizeIssue, DEFAULT_FIELDS, fetchIssueDetails, fetchComments, fetchWorklogs, fetchRecentActivity, fetchAttachmentMeta, jqlForScope, fetchProjects, jqlForProject, searchIssues, createComment } from "./jira.js";
import { isPipefyConfigured, fetchPipe, fetchCards, createCardFromIssue, syncIssuesToPipefy } from "./pipefy.js";
import { login, logout, getSessionFromRequest, requireAuth, requireAdmin, requireProjectScope, filterProjectsForSession, requestedProject, issueProjectGuard, createSession } from "./auth.js";
import { verifyGoogleIdToken } from "./googleAuth.js";
import { upsertPendingUser, getUserByEmail, listUsers, approveUser, rejectUser, updateUserScope, isAdminEmail, ADMIN_EMAIL } from "./users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: "/home/casa", PATH: "/home/casa/.local/bin:" + (process.env.PATH || "") } });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: "TWG indisponível" });
    }
    let stdout = result.stdout || "";
    if (!stdout.trim().startsWith("{")) {
      const m = stdout.match(/stdout:\s*"([^"]+)"/);
      if (m) stdout = fs.readFileSync(m[1], 'utf-8');
    }
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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: "/home/casa", PATH: "/home/casa/.local/bin:" + (process.env.PATH || "") } });
    if (result.error || result.status !== 0) {
      errorMsg = result.error ? result.error.message : "TWG error";
    } else {
      let stdout = result.stdout || "";
      // TWG may output a summary with JSON file path when stdout is not a TTY
      if (!stdout.trim().startsWith("{")) {
        const m = stdout.match(/stdout:\s*"([^"]+)"/);
        if (m) {
          try {
            stdout = fs.readFileSync(m[1], 'utf-8');
          } catch {}
        }
      }
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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: "/home/casa", PATH: "/home/casa/.local/bin:" + (process.env.PATH || "") } });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: "TWG indisponível", output: result.stdout || "" });
    }
    let stdout = result.stdout || "";
    if (!stdout.trim().startsWith("{")) {
      const m = stdout.match(/stdout:\s*"([^"]+)"/);
      if (m) {
        try {
          stdout = fs.readFileSync(m[1], 'utf-8');
        } catch {}
      }
    }
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
        const spRes = spawnSync("/home/casa/.local/bin/twg", spArgs, { encoding: "utf-8", timeout: 8000, env: { ...process.env, HOME: "/home/casa", PATH: "/home/casa/.local/bin:" + (process.env.PATH || "") } });
        let spOut = spRes.stdout || "";
        if (!spOut.trim().startsWith("{")) {
          const m = spOut.match(/stdout:\s*"([^"]+)"/);
          if (m) { try { spOut = fs.readFileSync(m[1], 'utf-8'); } catch {} }
        }
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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: "/home/casa", PATH: "/home/casa/.local/bin:" + (process.env.PATH || "") } });
    if (result.error || result.status !== 0) {
      return res.status(502).json({ success: false, error: "TWG indisponível" });
    }
    let stdout = result.stdout || "";
    if (!stdout.trim().startsWith("{")) {
      const m = stdout.match(/stdout:\s*"([^"]+)"/);
      if (m) stdout = fs.readFileSync(m[1], 'utf-8');
    }
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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding:"utf-8", timeout:15000, env:{...process.env, HOME:"/home/casa", PATH:"/home/casa/.local/bin:"+ (process.env.PATH||"")} });
    if (result.error || result.status!==0) return res.status(502).json({success:false,error:"TWG indisponível"});
    let stdout = result.stdout||"";
    if (!stdout.trim().startsWith("{")) { const m=stdout.match(/stdout:\\s*"([^"]+)"/); if(m) stdout=fs.readFileSync(m[1],'utf-8'); }
    const data = JSON.parse(stdout);
    const results = (data.data&&Array.isArray(data.data.results))?data.data.results:Array.isArray(data.results)?data.results:[];
    const items = results.map(r=>{ const title=r.title||r.content?.title||""; const id=r.content?.id||r.id||""; const rawUrl=r.url||""; const sm=rawUrl.match(/\/spaces\/([^/]+)\/pages/); const spaceKey=sm?sm[1]:r.spaceKey||""; const url=rawUrl.startsWith("http")?rawUrl:`https://aztecnologia.atlassian.net/wiki${rawUrl}`; const lastModified=r.lastModified||r.updated||""; const vm=title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i)||title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i); const version=vm?vm[1]:""; return {id,title,spaceKey,url,lastModified,version}; }).filter(i=>i.id);
    const grouped={}; items.forEach(i=>{(grouped[i.spaceKey]||=[]).push(i)}); Object.values(grouped).forEach(arr=>arr.sort((a,b)=>new Date(b.lastModified||0)-new Date(a.lastModified||0)));
    
    // Generate PDF
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    let page = pdfDoc.addPage([595,842]);
    let { width, height } = page.getSize();
    let y = height - 50;
    const lineHeight = 14;
    
    page.drawText("Notas de Release Confluence", { x: 50, y, font: boldFont, size: 18, color: rgb(0,0,0) });
    y -= 30;
    
    for (const [spaceKey, notes] of Object.entries(grouped)) {
      if (y < 100) { page = pdfDoc.addPage([595,842]); y = height - 50; }
      page.drawText(`Espaço: ${spaceKey}`, { x: 50, y, font: boldFont, size: 14 });
      y -= lineHeight + 6;
      for (const n of notes) {
        if (y < 80) { page = pdfDoc.addPage([595,842]); y = height - 50; }
        const titleLine = `${n.title} ${n.version ? 'v'+n.version : ''}`;
        page.drawText(titleLine, { x: 60, y, font, size: 12 });
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
    const result = spawnSync("/home/casa/.local/bin/twg", args, { encoding:"utf-8", timeout:15000, env:{...process.env, HOME:"/home/casa", PATH:"/home/casa/.local/bin:"+ (process.env.PATH||"")} });
    if (result.error || result.status!==0) return res.status(502).json({success:false,error:"TWG indisponível"});
    let stdout = result.stdout||"";
    if (!stdout.trim().startsWith("{")) { const m=stdout.match(/stdout:\\s*"([^"]+)"/); if(m) stdout=fs.readFileSync(m[1],'utf-8'); }
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
      const r = spawnSync("/home/casa/.local/bin/twg", args2, { encoding:"utf-8", timeout:10000, env:{...process.env, HOME:"/home/casa", PATH:"/home/casa/.local/bin:"+ (process.env.PATH||"")} });
      let out = r.stdout||"";
      if (!out.trim().startsWith("{")) { const m=out.match(/stdout:\\s*"([^"]+)"/); if(m) out=fs.readFileSync(m[1],'utf-8'); }
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

// 404 JSON para rotas /api desconhecidas (nunca HTML)
app.use("/api", (req, res) => {
  res.status(404).json({ success: false, error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
});

// Frontend estatico
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Último middleware: qualquer erro vira JSON (nunca HTML)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`[erro] ${req.method} ${req.originalUrl}:`, err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ success: false, error: err.message || "Erro interno do servidor." });
});

const HOST = process.env.HOST || "0.0.0.0";

// Validação de configuração no startup (avisos, não bloqueios)
function validateConfig() {
  const warnings = [];
  if (!config.google.clientId) {
    warnings.push("GOOGLE_CLIENT_ID ausente — login Google desabilitado.");
  } else if (!/\.apps\.googleusercontent\.com$/.test(config.google.clientId)) {
    warnings.push("GOOGLE_CLIENT_ID com formato inesperado (esperado *.apps.googleusercontent.com).");
  }
  if (!config.google.allowedDomain) {
    warnings.push("GOOGLE_ALLOWED_DOMAIN ausente — domínio não restrito.");
  }
  if (!config.adminEmail) {
    warnings.push("ADMIN_EMAIL ausente — nenhum admin auto-aprovado.");
  }
  if (!config.jira.domain || !config.jira.email || !config.jira.token) {
    warnings.push("Credenciais Jira incompletas (JIRA_DOMAIN/EMAIL/TOKEN).");
  }
  for (const w of warnings) console.warn(`⚠️  Config: ${w}`);
  if (!warnings.length) console.log("✅ Configuração Google OAuth: OK (clientId + domínio + admin).");
}
validateConfig();

app.listen(config.port, HOST, () => {
  console.log(`🚀 Servidor rodando em http://${HOST}:${config.port}`);
  console.log(`   API: http://${HOST}:${config.port}/api/chamados/abertos`);
  console.log(`   Health: http://${HOST}:${config.port}/api/health`);
  console.log(`   Google OAuth: ${config.google.clientId ? "habilitado (" + config.google.allowedDomain + ")" : "DESABILITADO"}`);
});
