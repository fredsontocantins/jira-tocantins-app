import { config, jiraAuthHeader } from "./config.js";

const BASE = () => `${config.jira.domain}/rest/api/3`;

const JIRA_ERROR_MESSAGES = {
  401: "A autenticação no Jira foi recusada. Confira as credenciais configuradas.",
  403: "A conta configurada não tem permissão para consultar estes dados no Jira.",
  404: "O recurso não foi encontrado ou não está acessível nesta conta.",
  429: "O Jira limitou temporariamente as consultas. Aguarde um pouco e tente novamente.",
};

const JIRA_TIMEOUT = 30000;

async function jiraFetch(path, options = {}) {
  const url = `${config.jira.domain}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(JIRA_TIMEOUT),
    });
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`O Jira demorou demais para responder (timeout ${JIRA_TIMEOUT/1000}s). Tente novamente em instantes.`);
    }
    throw new Error(`Falha de rede ao consultar o Jira: ${err?.message || err}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message;
    switch (res.status) {
      case 401:
        message = "A autenticação no Jira foi recusada. Confira as credenciais configuradas.";
        break;
      case 403:
        message = "A conta configurada não tem permissão para consultar estes dados no Jira.";
        break;
      case 404:
        message = "O recurso não foi encontrado ou não está acessível nesta conta.";
        break;
      case 429:
        message = "O Jira limitou temporariamente as consultas. Aguarde um pouco e tente novamente.";
        break;
      default:
        message = `Jira ${res.status} ${res.statusText}: ${text.slice(0, 300)}`;
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function fetchFilter(filterId) {
  return jiraFetch(`/rest/api/3/filter/${filterId}`);
}

export const DEFAULT_FIELDS = [
  "summary",
  "status",
  "priority",
  "issuetype",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolution",
  "project",
  "attachment",
  "comment",
];

export async function fetchIssuesByJql(jql, fields = DEFAULT_FIELDS, maxResults = config.jira.maxResults, expand = []) {
  const all = [];
  let nextPageToken = null;
  let isLast = false;
  const pageSize = Math.min(maxResults || 100, 100);

  while (!isLast && all.length < (maxResults || Infinity)) {
    const body = {
      jql,
      maxResults: pageSize,
      fields,
    };
    if (expand && (Array.isArray(expand) ? expand.length : expand)) {
      body.expand = Array.isArray(expand) ? expand.join(",") : expand;
    }
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const data = await jiraFetch("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const issues = data.issues || [];
    all.push(...issues);
    nextPageToken = data.nextPageToken || null;
    isLast = data.isLast === true || issues.length === 0 || !nextPageToken;
    if (all.length >= (maxResults || Infinity)) break;
  }

  return all.slice(0, maxResults || all.length);
}

export function normalizeIssue(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    id: issue.id,
    url: `${config.jira.domain}/browse/${issue.key}`,
    summary: f.summary || "",
    status: f.status ? f.status.name : null,
    statusCategory: f.status?.statusCategory?.key || null,
    priority: f.priority ? f.priority.name : null,
    issueType: f.issuetype ? f.issuetype.name : null,
    assignee: f.assignee
      ? { name: f.assignee.displayName, email: f.assignee.emailAddress, accountId: f.assignee.accountId }
      : null,
    reporter: f.reporter ? { name: f.reporter.displayName, email: f.reporter.emailAddress, accountId: f.reporter.accountId } : null,
    creator: f.creator ? { name: f.creator.displayName, email: f.creator.emailAddress, accountId: f.creator.accountId } : null,
    created: f.created || null,
    updated: f.updated || null,
    resolution: f.resolution ? f.resolution.name : null,
    project: f.project ? { key: f.project.key, name: f.project.name } : null,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name).filter(Boolean),
    attachments: (f.attachment || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      url: a.content,
      thumbnail: a.thumbnail || null,
    })),
  };
}

// Lista de projetos (espaços) do Jira
export async function fetchProjects() {
  const all = [];
  let startAt = 0;
  const pageSize = 100;
  let isLast = false;
  while (!isLast) {
    const data = await jiraFetch(`/rest/api/3/project/search?maxResults=${pageSize}&startAt=${startAt}&orderBy=name`);
    const values = data.values || [];
    all.push(...values);
    isLast = data.isLast === true || values.length === 0 || all.length >= (data.total || all.length);
    startAt += values.length;
    if (values.length === 0) break;
  }
  return all.map((p) => ({
    key: p.key,
    name: p.name,
    type: p.projectTypeKey,
    style: p.style,
    lead: p.lead ? p.lead.displayName : null,
  }));
}

// JQL por escopo de projeto (legado)
export function jqlForScope(scope) {
  if (scope === "all") {
    return 'project is not EMPTY AND statusCategory != Done ORDER BY updated DESC';
  }
  return config.jira.filterJql;
}

// JQL por projeto/espaço selecionado
export function jqlForProject(project, openOnly) {
  const conditions = [];
  if (project && project !== "all") {
    conditions.push(`project = "${project}"`);
  } else {
    conditions.push("project is not EMPTY");
  }
  if (openOnly) {
    conditions.push("statusCategory != Done");
  }
  return conditions.join(" AND ") + " ORDER BY updated DESC";
}

export async function fetchAbertos(jqlOverride) {
  const jql = jqlOverride || config.jira.filterJql;
  const issues = await fetchIssuesByJql(jql, DEFAULT_FIELDS, config.jira.maxResults);
  return issues.map(normalizeIssue);
}

export async function fetchAbertosByScope(scope) {
  return fetchAbertos(jqlForScope(scope));
}

// Detalhes de uma issue com changelog
const SORT_MAP = {
  updated: "updated DESC",
  created: "created DESC",
  priority: "priority ASC, updated DESC",
  key: "key ASC",
  project: "project ASC, updated DESC",
};

export async function searchIssues({ projectKey = "", query = "", sort = "updated", nextPageToken = "", openOnly = true, maxResults = 100 } = {}) {
  const clauses = [];
  if (openOnly) clauses.push("statusCategory != Done");
  const pk = String(projectKey || "").trim();
  if (pk && pk.toLowerCase() !== "all") {
    clauses.push(`project = "${pk.replace(/"/g, '\\"')}"`);
  } else {
    clauses.push("project is not EMPTY");
  }
  const q = String(query || "").trim().slice(0, 160);
  if (q) {
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q)) {
      clauses.push(`key = "${q.toUpperCase()}"`);
    } else {
      clauses.push(`text ~ "${q.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    }
  }
  const orderBy = SORT_MAP[sort] || "updated DESC";
  const body = {
    jql: `${clauses.join(" AND ")} ORDER BY ${orderBy}`,
    maxResults: Math.min(maxResults || 100, 100),
    fields: DEFAULT_FIELDS,
  };
  if (nextPageToken) body.nextPageToken = nextPageToken;

  const data = await jiraFetch("/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const issues = (data.issues || []).map(normalizeIssue);
  return {
    issues,
    total: Number.isFinite(Number(data.total)) ? Number(data.total) : null,
    nextPageToken: data.nextPageToken || null,
    isLast: data.isLast === true || !data.nextPageToken || (data.issues || []).length === 0,
  };
}

const STANDARD_FIELDS = new Set([
  "summary","description","status","issuetype","priority","assignee","reporter","created","updated",
  "resolution","project","attachment","comment","worklog","issuelinks","duedate","labels","components",
  "fixVersions","versions","environment","parent","subtasks","timetracking","resolutiondate",
  "statuscategorychangedate","lastViewed",
]);

function buildParticipants(issue, comments, extra = []) {
  const seen = new Set();
  const out = [];
  const push = (user, role) => {
    if (!user) return;
    const id = user.accountId || user.email || user.name;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ accountId: user.accountId || null, name: user.name || null, email: user.email || null, role });
  };
  push(issue && issue.assignee, "assignee");
  push(issue && issue.reporter, "reporter");
  push(issue && issue.creator, "creator");
  (comments || []).forEach((c) => push(c && c.author, "commenter"));
  (extra || []).forEach((u) => push(u, u && u.role ? u.role : "participant"));
  return out;
}

export async function fetchOrganizationMembers(orgId) {
  if (!orgId) return [];
  const all = [];
  let start = 0;
  const limit = 50;
  while (all.length < 500) {
    let data;
    try {
      data = await jiraFetch(`/rest/servicedeskapi/organization/${encodeURIComponent(orgId)}/user?limit=${limit}&start=${start}`);
    } catch (err) {
      break;
    }
    const values = data.values || data.users || [];
    all.push(...values);
    const next = data._links && data._links.next;
    if (!next || values.length === 0) break;
    start += values.length;
  }
  return all.map((u) => ({
    accountId: u.accountId || null,
    name: u.displayName || u.name || null,
    email: u.emailAddress || u.email || null,
  }));
}

export async function fetchIssueDetails(key) {
  const data = await jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(key)}?expand=changelog,renderedFields,names&fields=*all`
  );
  const fields = data.fields || {};
  const issue = normalizeIssue(data);
  const comments = (fields.comment?.comments || []).map(normalizeComment);

  // Participantes de organização/cliente (JSM)
  const requestParticipants = Array.isArray(fields.customfield_10029) ? fields.customfield_10029 : [];
  const organizations = Array.isArray(fields.customfield_10002) ? fields.customfield_10002 : [];
  const extraParticipants = requestParticipants.map((u) => ({
    accountId: u.accountId || null,
    name: u.displayName || u.name || null,
    email: u.emailAddress || u.email || null,
    role: "request-participant",
  }));
  for (const org of organizations) {
    if (!org || !org.id) continue;
    try {
      const members = await fetchOrganizationMembers(org.id);
      members.forEach((m) => extraParticipants.push({ ...m, role: "organization" }));
    } catch (err) {
      // ignore org fetch failures
    }
  }

  const customFields = Object.entries(fields)
    .filter(([k, v]) => !STANDARD_FIELDS.has(k) && !k.startsWith("_") && v != null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => ({ key: k, label: (data.names && data.names[k]) || k, value: v }));
  return {
    issue,
    fieldNames: data.names || {},
    renderedFields: data.renderedFields || {},
    customFields,
    changelog: data.changelog || { histories: [] },
    comments,
    participants: buildParticipants(issue, comments, extraParticipants),
    description: fields.description || null,
  };
}

export function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text || ("@" + (node.attrs?.id || ""));
  if (node.type === "emoji") return node.attrs?.shortName || "";
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url || "";
  const inner = adfToText(node.content);
  // add newlines for block-level nodes
  const blockTypes = new Set(["paragraph","heading","bulletList","orderedList","listItem","blockquote","codeBlock","table","tableRow","panel","rule"]);
  if (blockTypes.has(node.type)) return inner + "\n";
  return inner;
}

export function commentVisibility(c) {
  const marker = Array.isArray(c.properties)
    ? c.properties.find((p) => p && p.key === "sd.public.comment")
    : null;
  if (c.jsdPublic === false || marker?.value?.internal === true) return "internal";
  if (c.jsdPublic === true || marker?.value?.internal === false) return "public";
  if (c.visibility?.value) return "restricted";
  return "unknown";
}

export function normalizeComment(c) {
  let body = "";
  if (typeof c.body === "string") body = c.body;
  else if (c.body && c.body.content) body = adfToText(c.body).trim();
  else if (c.body) body = JSON.stringify(c.body);
  return {
    id: c.id,
    author: c.author ? { name: c.author.displayName, email: c.author.emailAddress, accountId: c.author.accountId } : null,
    body,
    created: c.created,
    updated: c.updated,
    visibility: commentVisibility(c),
  };
}

export async function fetchComments(key) {
  const data = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
  return (data.comments || []).map(normalizeComment);
}

// Cria um comentario/nota em um chamado (interno = nota interna JSM)
// mentions: lista de { name, accountId } para gerar menções reais no ADF
export async function createComment(key, bodyText, { internal = false, mentions = [] } = {}) {
  const mentionMap = new Map((mentions || []).filter((m) => m && m.name && m.accountId).map((m) => [String(m.name).toLowerCase(), m]));
  const mentionNames = [...new Set((mentions || []).filter((m) => m && m.name && m.accountId).map((m) => String(m.name)))]
    .sort((a, b) => b.length - a.length);
  const mentionPattern = mentionNames.length
    ? new RegExp("@(" + mentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![A-Za-z0-9])", "gi")
    : null;

  function parseMentions(text) {
    if (!mentionPattern) return [{ type: "text", text }];
    const nodes = [];
    let last = 0;
    let m;
    // reset lastIndex
    mentionPattern.lastIndex = 0;
    while ((m = mentionPattern.exec(text)) !== null) {
      if (m.index > last) nodes.push({ type: "text", text: text.slice(last, m.index) });
      const found = mentionMap.get(String(m[1]).toLowerCase());
      if (found) {
        nodes.push({ type: "mention", attrs: { id: found.accountId, text: "@" + found.name, accessLevel: "" } });
      } else {
        nodes.push({ type: "text", text: m[0] });
      }
      last = m.index + m[0].length;
      if (mentionPattern.lastIndex === m.index) mentionPattern.lastIndex++;
    }
    if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
    if (!nodes.length) nodes.push({ type: "text", text });
    return nodes.filter((n) => !(n.type === "text" && n.text === ""));
  }

  const paragraphs = String(bodyText || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const blocks = (paragraphs.length ? paragraphs : [String(bodyText || "").trim()])
    .map((para) => ({
      type: "paragraph",
      content: para
        ? para.split("\n").flatMap((line, idx, arr) => {
            const nodes = parseMentions(line);
            if (idx < arr.length - 1) nodes.push({ type: "hardBreak" });
            return nodes;
          })
        : [],
    }));
  const adf = { type: "doc", version: 1, content: blocks };
  const payload = { body: adf };
  if (internal) {
    payload.properties = [{ key: "sd.public.comment", value: { internal: true } }];
  }
  const data = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeComment(data);
}

export async function fetchWorklogs(key) {
  const data = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/worklog`);
  return (data.worklogs || []).map((w) => ({
    id: w.id,
    author: w.author ? { name: w.author.displayName, accountId: w.author.accountId } : null,
    timeSpent: w.timeSpent,
    timeSpentSeconds: w.timeSpentSeconds,
    started: w.started,
    created: w.created,
    comment: typeof w.comment === "string" ? w.comment : (w.comment ? adfToText(w.comment).trim() : null),
  }));
}

export async function fetchAttachmentMeta(id) {
  return jiraFetch(`/rest/api/3/attachment/${encodeURIComponent(id)}`);
}

// Agrega atividade recente (transições de status/assignee + comentários) dos chamados abertos
export async function fetchRecentActivity(limit = 60, jqlOverride) {
  const jql = jqlOverride || config.jira.filterJql;
  const issues = await fetchIssuesByJql(jql, DEFAULT_FIELDS, config.jira.maxResults, ["changelog"]);
  const events = [];

  for (const issue of issues) {
    const ch = issue.changelog || { histories: [] };
    for (const h of ch.histories || []) {
      for (const item of h.items || []) {
        events.push({
          type: "change",
          issueKey: issue.key,
          issueSummary: issue.fields?.summary || "",
          author: h.author ? h.author.displayName : null,
          created: h.created,
          field: item.field,
          from: item.fromString,
          to: item.toString,
        });
      }
    }
  }

  // Comentários: busca por issue (limitado aos 10 mais recentemente atualizados para performance)
  const recentIssues = [...issues]
    .sort((a, b) => new Date(b.fields?.updated || 0) - new Date(a.fields?.updated || 0))
    .slice(0, 10);

  await Promise.all(
    recentIssues.map(async (issue) => {
      try {
        const comments = await fetchComments(issue.key);
        for (const c of comments) {
          events.push({
            type: "comment",
            issueKey: issue.key,
            issueSummary: issue.fields?.summary || "",
            author: c.author ? c.author.name : null,
            created: c.created,
            body: (c.body || "").slice(0, 280),
          });
        }
      } catch (e) {
        // ignora falhas individuais
      }
    })
  );

  events.sort((a, b) => new Date(b.created) - new Date(a.created));
  return events.slice(0, limit);
}