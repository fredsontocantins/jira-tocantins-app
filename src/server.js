import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const TWG = process.env.TWG_BIN || "/opt/twg/bin/twg";
function runTwg(args){
  const cmd = `sudo -u casa ${TWG} ${args.map(a=>`'${a.replace(/'/g,"'\\''")}'`).join(' ')}`;
  return spawnSync('bash', ['-c', cmd], { encoding:'utf-8', timeout:15000, env:{...process.env, HOME:'/home/casa'} });
}
import { config, jiraAuthHeader } from "./config.js";
import { fetchAbertos, fetchFilter, fetchIssuesByJql, normalizeIssue, DEFAULT_FIELDS, fetchIssueDetails, fetchComments, fetchWorklogs, fetchRecentActivity, fetchAttachmentMeta, jqlForScope, fetchProjects, jqlForProject, searchIssues, createComment } from "./jira.js";
import { isPipefyConfigured, fetchPipe, fetchCards, createCardFromIssue, syncIssuesToPipefy } from "./pipefy.js";
import { login, logout, getSessionFromRequest, requireAuth, requireAdmin, requireProjectScope, filterProjectsForSession, requestedProject, issueProjectGuard, createSession } from "./auth.js";
import { verifyGoogleIdToken } from "./googleAuth.js";
import { upsertPendingUser, getUserByEmail, listUsers, approveUser, rejectUser, updateUserScope, isAdminEmail, ADMIN_EMAIL } from "./users.js";
import { syncReleaseNotes, listReleaseNotes, getStatus } from "./release-notes.js";

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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: process.env.HOME || "/home/app", PATH: "/opt/twg/bin:" + (process.env.PATH || "") } });
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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: process.env.HOME || "/home/app", PATH: "/opt/twg/bin:" + (process.env.PATH || "") } });
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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: process.env.HOME || "/home/app", PATH: "/opt/twg/bin:" + (process.env.PATH || "") } });
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
        const spRes = spawnSync("/opt/twg/bin/twg", spArgs, { encoding: "utf-8", timeout: 8000, env: { ...process.env, HOME: process.env.HOME || "/home/app", PATH: "/opt/twg/bin:" + (process.env.PATH || "") } });
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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding: "utf-8", timeout: 15000, env: { ...process.env, HOME: process.env.HOME || "/home/app", PATH: "/opt/twg/bin:" + (process.env.PATH || "") } });
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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding:"utf-8", timeout:15000, env:{...process.env, HOME: process.env.HOME || "/home/app", PATH:"/opt/twg/bin:"+ (process.env.PATH||"")} });
    if (result.error || result.status!==0) return res.status(502).json({success:false,error:"TWG indisponível"});
    let stdout = result.stdout||"";
    if (!stdout.trim().startsWith("{")) { const m=stdout.match(/stdout:\\s*"([^"]+)"/); if(m) stdout=fs.readFileSync(m[1],'utf-8'); }
    const data = JSON.parse(stdout);
    const results = (data.data&&Array.isArray(data.data.results))?data.data.results:Array.isArray(data.results)?data.results:[];
    const items = results.map(r=>{ const title=r.title||r.content?.title||""; const id=r.content?.id||r.id||""; const rawUrl=r.url||""; const sm=rawUrl.match(/\/spaces\/([^/]+)\/pages/); const spaceKey=sm?sm[1]:r.spaceKey||""; const url=rawUrl.startsWith("http")?rawUrl:`https://aztecnologia.atlassian.net/wiki${rawUrl}`; const lastModified=r.lastModified||r.updated||""; const vm=title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*) /i)||title.match(/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)$/i); const version=vm?vm[1]:""; return {id,title,spaceKey,url,lastModified,version}; }).filter(i=>i.id);
    const grouped={}; items.forEach(i=>{(grouped[i.spaceKey]||=[]).push(i)}); Object.values(grouped).forEach(arr=>arr.sort((a,b)=>new Date(b.lastModified||0)-new Date(a.lastModified||0)));
    
    // Helper to fetch content HTML
    const fetchContentHtml = async (id) => {
      try {
        const args = ["confluence","content","get",id,"--format","html","--detail","full","--include-metadata","--output","json"];
        const r = spawnSync("/opt/twg/bin/twg", args, { encoding:"utf-8", timeout:10000, env:{...process.env, HOME: process.env.HOME || "/home/app", PATH:"/opt/twg/bin:"+ (process.env.PATH||"")} });
        if (r.error || r.status!==0) return "";
        let out = r.stdout||"";
        if (!out.trim().startsWith("{")) { const m=out.match(/stdout:\\s*"([^"]+)"/); if(m) out=fs.readFileSync(m[1],'utf-8'); }
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
    const result = spawnSync("/opt/twg/bin/twg", args, { encoding:"utf-8", timeout:15000, env:{...process.env, HOME: process.env.HOME || "/home/app", PATH:"/opt/twg/bin:"+ (process.env.PATH||"")} });
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
      const r = spawnSync("/opt/twg/bin/twg", args2, { encoding:"utf-8", timeout:10000, env:{...process.env, HOME: process.env.HOME || "/home/app", PATH:"/opt/twg/bin:"+ (process.env.PATH||"")} });
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
// ===== Notas de Release (Confluence) =====
app.get("/api/release-notes", requireAuth, async (req, res) => {
  try {
    if (!getStatus().configurado) {
      return res.status(503).json({ success: false, error: "Confluence não configurado (CONFLUENCE_EMAIL/CONFLUENCE_TOKEN ausentes)." });
    }
    const { version, system, limit } = req.query;
    const data = listReleaseNotes({ version, system, limit });
    res.json({ success: true, count: data.length, data, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.post("/api/release-notes/sync", requireAuth, async (req, res) => {
  try {
    if (!getStatus().configurado) {
      return res.status(503).json({ success: false, error: "Confluence não configurado (CONFLUENCE_EMAIL/CONFLUENCE_TOKEN ausentes)." });
    }
    const resultado = await syncReleaseNotes();
    res.json({ success: true, ...resultado, syncedAt: new Date().toISOString() });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

app.get("/api/release-notes/status", requireAuth, async (req, res) => {
  res.json({ success: true, ...getStatus(), checkedAt: new Date().toISOString() });
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
