import { config, jiraAuthHeader } from "./config.js";

const BASE = () => `${config.jira.domain}/rest/api/3`;

async function jiraFetch(path, options = {}) {
  const url = `${config.jira.domain}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
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
    reporter: f.reporter ? { name: f.reporter.displayName, email: f.reporter.emailAddress } : null,
    created: f.created || null,
    updated: f.updated || null,
    resolution: f.resolution ? f.resolution.name : null,
    project: f.project ? { key: f.project.key, name: f.project.name } : null,
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
export async function fetchIssueDetails(key) {
  const data = await jiraFetch(
    `/rest/api/3/issue/${encodeURIComponent(key)}?expand=changelog&fields=summary,status,priority,issuetype,assignee,reporter,created,updated,resolution,description,comment,attachment`
  );
  return {
    issue: normalizeIssue(data),
    changelog: data.changelog || { histories: [] },
    comments: (data.fields?.comment?.comments || []).map(normalizeComment),
    description: data.fields?.description || null,
  };
}

export function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return "@" + (node.attrs?.text || node.attrs?.id || "");
  if (node.type === "emoji") return node.attrs?.shortName || "";
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url || "";
  const inner = adfToText(node.content);
  // add newlines for block-level nodes
  const blockTypes = new Set(["paragraph","heading","bulletList","orderedList","listItem","blockquote","codeBlock","table","tableRow","panel","rule"]);
  if (blockTypes.has(node.type)) return inner + "\n";
  return inner;
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
  };
}

export async function fetchComments(key) {
  const data = await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`);
  return (data.comments || []).map(normalizeComment);
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