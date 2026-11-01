// Autenticacao simples por usuarios/senhas fixos + tokens em memoria
// - tocantins  / senha123       -> ve somente o espaco TO
// - operacoes  / operacoes@123  -> ve tudo (todos os projetos)

const USERS = [
  { username: "tocantins", password: "senha123", allowedProjects: ["TO"] },
  { username: "operacoes", password: "operacoes@123", allowedProjects: ["all"] },
];

// token -> user (sessoes em memoria; expiram em 12h)
const sessions = new Map();
const SESSION_TTL = 12 * 60 * 60 * 1000;

export function createSession({ username, email, allowedProjects, isAdmin = false }) {
  const now = Date.now();
  // limpa sessoes expiradas
  for (const [tok, s] of sessions) {
    if (now > s.expires) sessions.delete(tok);
  }
  const token = newToken();
  sessions.set(token, {
    username,
    email: email || username,
    allowedProjects: allowedProjects || [],
    isAdmin: !!isAdmin,
    expires: now + SESSION_TTL,
  });
  return {
    token,
    user: { username, email: email || username, allowedProjects: allowedProjects || [], isAdmin: !!isAdmin },
    expiresAt: new Date(now + SESSION_TTL).toISOString(),
  };
}

function newToken() {
  const bytes = new Uint8Array(20);
  // globalThis.crypto (disponivel no Node 20)
  (globalThis.crypto || { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); } }).getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

export function login(username, password) {
  const user = USERS.find(
    (u) => u.username === username && u.password === password
  );
  if (!user) return null;
  // limpa sessoes expiradas
  const now = Date.now();
  for (const [tok, s] of sessions) {
    if (now > s.expires) sessions.delete(tok);
  }
  const token = newToken();
  sessions.set(token, {
    username: user.username,
    allowedProjects: user.allowedProjects,
    expires: now + SESSION_TTL,
  });
  return {
    token,
    user: { username: user.username, allowedProjects: user.allowedProjects },
    expiresAt: new Date(now + SESSION_TTL).toISOString(),
  };
}

export function getSessionFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// Remove sessao
export function logout(token) {
  sessions.delete(token);
}

// Extrai o escopo solicitado (params atuais + legado)
export function requestedProject(req) {
  const p = req.query.project !== undefined ? req.query.project : null;
  if (p) return String(p);
  const scope = req.query.scope !== undefined ? req.query.scope : null;
  if (scope === "all") return "all";
  if (scope) return "TO"; // legado scope=to
  return "TO"; // default
}

// Middleware: exige admin
export function requireAdmin(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) return res.status(401).json({ success: false, error: "Nao autenticado." });
  if (!session.isAdmin) return res.status(403).json({ success: false, error: "Acesso restrito ao administrador." });
  req.session = session;
  next();
}

// Middleware: exige sessao valida
export function requireAuth(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ success: false, error: "Nao autenticado. Faca login." });
  }
  req.session = session;
  next();
}

// Middleware: verifica se o usuario pode acessar o escopo pedido
export function requireProjectScope(req, res, next) {
  const requested = requestedProject(req);
  const allowed = req.session.allowedProjects || [];
  if (allowed.includes("all")) return next();
  if (allowed.includes(requested)) return next();
  return res.status(403).json({
    success: false,
    error: `Usuario ${req.session.username} nao tem acesso ao espaco '${requested}'.`,
  });
}

// Middleware: verifica se o usuario pode acessar uma issue pelo prefixo da chave (TO-123 -> TO)
export function issueProjectGuard(req, res, next) {
  const key = String(req.params.key || "");
  const prefix = key.split("-")[0];
  const allowed = req.session.allowedProjects || [];
  if (allowed.includes("all") || allowed.includes(prefix)) return next();
  return res.status(403).json({ success: false, error: `Usuario ${req.session.username} nao tem acesso ao chamado '${key}'.` });
}

// Filtra lista de projetos conforme permissoes do usuario
export function filterProjectsForSession(projects, session) {
  const allowed = session.allowedProjects || [];
  if (allowed.includes("all")) return projects;
  return projects.filter((p) => allowed.includes(p.key));
}
