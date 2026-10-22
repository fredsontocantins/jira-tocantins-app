import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config, jiraAuthHeader } from "./config.js";
import { fetchAbertos, fetchFilter, fetchIssuesByJql, normalizeIssue, DEFAULT_FIELDS, fetchIssueDetails, fetchComments, fetchWorklogs, fetchRecentActivity, fetchAttachmentMeta, jqlForScope, fetchProjects, jqlForProject } from "./jira.js";
import { isPipefyConfigured, fetchPipe, fetchCards, createCardFromIssue, syncIssuesToPipefy } from "./pipefy.js";
import { login, logout, getSessionFromRequest, requireAuth, requireProjectScope, filterProjectsForSession, requestedProject, issueProjectGuard } from "./auth.js";

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
  res.json({ success: true, user: { username: session.username, allowedProjects: session.allowedProjects }, expiresAt: new Date(session.expires).toISOString() });
});
app.post("/api/logout", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (token) logout(token);
  res.json({ success: true });
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

app.get("/api/chamados/abertos", requireAuth, requireProjectScope, async (req, res) => {
  try {
    // Compatibilidade com escopo antigo
    let project = req.query.project;
    if (!project && req.query.scope) {
      project = req.query.scope === "all" ? "all" : "TO";
    }
    if (!project) project = "TO";
    const openOnly = req.query.open === "true" || req.query.open === "1";
    const refresh = req.query.refresh === "true";
    const cacheKey = `abertos:${project}:${openOnly}`;
    let data = refresh ? null : getCached(cacheKey);
    const jql = jqlForProject(project, openOnly);
    if (!data) {
      data = await fetchAbertos(jql);
      setCached(cacheKey, data);
    }
    res.json({
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
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
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
app.get("/api/attachment/:id", requireAuth, async (req, res) => {
  try {
    const meta = await fetchAttachmentMeta(req.params.id);
    const contentRes = await fetch(meta.content, {
      headers: { Authorization: jiraAuthHeader(), Accept: "*/*" },
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
app.get("/api/attachment/:id/thumbnail", requireAuth, async (req, res) => {
  try {
    const meta = await fetchAttachmentMeta(req.params.id);
    const thumbUrl = meta.thumbnail || meta.content;
    const contentRes = await fetch(thumbUrl, {
      headers: { Authorization: jiraAuthHeader(), Accept: "*/*" },
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

// Frontend estatico
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const HOST = process.env.HOST || "0.0.0.0";
app.listen(config.port, HOST, () => {
  console.log(`🚀 Servidor rodando em http://${HOST}:${config.port}`);
  console.log(`   API: http://${HOST}:${config.port}/api/chamados/abertos`);
  console.log(`   Health: http://${HOST}:${config.port}/api/health`);
});