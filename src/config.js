import dotenv from "dotenv";
dotenv.config();

export const config = {
  jira: {
    domain: (process.env.JIRA_DOMAIN || "").replace(/\/$/, ""),
    email: process.env.JIRA_EMAIL || "",
    token: process.env.JIRA_TOKEN || "",
    project: process.env.JIRA_PROJECT || "TO",
    filterId: process.env.JIRA_FILTER_ID || "11083",
    maxResults: parseInt(process.env.JIRA_MAX_RESULTS || "100", 10),
    filterJql:
      process.env.JIRA_FILTER_JQL ||
      'project = "TO" AND resolution = Unresolved AND status IN (Aberto, "Aguardando cliente", "Aplicar Script", Consultoria, "Em Atendimento Nível 2", "Em Atendimento Nível 3", "Esperando o Cliente", "Nível 2", "Nível 3") ORDER BY assignee ASC, "Time to resolution" ASC',
  },
  pipefy: {
    token: process.env.PIPEFY_TOKEN || "",
    apiUrl: (process.env.PIPEFY_API_URL || "https://api.pipefy.com/graphql").replace(/\/$/, ""),
    pipeId: process.env.PIPEFY_PIPE_ID || "",
    fieldMap: {
      title: process.env.PIPEFY_FIELD_TITLE || "title",
      description: process.env.PIPEFY_FIELD_DESCRIPTION || "description",
      jiraKey: process.env.PIPEFY_FIELD_JIRA_KEY || "jira_key",
      status: process.env.PIPEFY_FIELD_STATUS || "status",
      priority: process.env.PIPEFY_FIELD_PRIORITY || "priority",
      assignee: process.env.PIPEFY_FIELD_ASSIGNEE || "assignee",
    },
  },
  port: parseInt(process.env.PORT || "3000", 10),
};

export function jiraAuthHeader() {
  const { email, token } = config.jira;
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

export function pipefyAuthHeader() {
  return `Bearer ${config.pipefy.token}`;
}