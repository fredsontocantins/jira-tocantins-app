import { config, pipefyAuthHeader } from "./config.js";

const BASE = () => config.pipefy.apiUrl;

// Helper de chamada GraphQL (espelha jiraFetch)
async function pipefyFetch(query, variables = {}) {
  const res = await fetch(BASE(), {
    method: "POST",
    headers: {
      Authorization: pipefyAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pipefy ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Pipefy GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }
  return json.data;
}

// Verifica se o Pipefy esta configurado
export function isPipefyConfigured() {
  return Boolean(config.pipefy.token && config.pipefy.pipeId);
}

// Informacoes do usuario autenticado
export async function fetchMe() {
  const data = await pipefyFetch(`query { me { id name email } }`);
  return data.me;
}

// Detalhes do pipe (fases + campos)
export async function fetchPipe(pipeId) {
  const id = pipeId || config.pipefy.pipeId;
  const data = await pipefyFetch(
    `query($id: ID!) {
      pipe(id: $id) {
        id name
        phases { id name }
        start_form_fields { id label type }
      }
    }`,
    { id }
  );
  return data.pipe;
}

// Lista cards de um pipe (paginado por cursor)
export async function fetchCards(pipeId, first = 50, after = null) {
  const id = pipeId || config.pipefy.pipeId;
  const data = await pipefyFetch(
    `query($id: ID!, $first: Int, $after: String) {
      cards(pipe_id: $id, first: $first, after: $after) {
        edges { node { id title current_phase { id name } fields { name value } } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { id, first, after }
  );
  return data.cards;
}

// Cria um card a partir de um issue normalizado do Jira
export async function createCardFromIssue(issue, pipeId) {
  const id = pipeId || config.pipefy.pipeId;
  const fm = config.pipefy.fieldMap;
  const fields = [];
  if (fm.title) fields.push({ field_id: fm.title, field_value: issue.summary || "" });
  if (fm.description) fields.push({ field_id: fm.description, field_value: issue.description || issue.summary || "" });
  if (fm.jiraKey) fields.push({ field_id: fm.jiraKey, field_value: issue.key || "" });
  if (fm.status) fields.push({ field_id: fm.status, field_value: issue.status || "" });
  if (fm.priority) fields.push({ field_id: fm.priority, field_value: issue.priority || "" });
  if (fm.assignee && issue.assignee) {
    fields.push({ field_id: fm.assignee, field_value: issue.assignee.name || "" });
  }

  const data = await pipefyFetch(
    `mutation($pipeId: ID!, $fields: [FieldValueInput!]) {
      createCard(input: { pipe_id: $pipeId, fields_attributes: $fields }) {
        card { id title current_phase { id name } }
      }
    }`,
    { pipeId: id, fields }
  );
  return data.createCard.card;
}

// Move um card para outra fase
export async function moveCardToPhase(cardId, phaseId) {
  const data = await pipefyFetch(
    `mutation($cardId: ID!, $phaseId: ID!) {
      moveCardToPhase(input: { card_id: $cardId, destination_phase_id: $phaseId }) {
        card { id current_phase { id name } }
      }
    }`,
    { cardId, phaseId }
  );
  return data.moveCardToPhase.card;
}

// Atualiza um campo de um card
export async function updateCardField(cardId, fieldId, value) {
  const data = await pipefyFetch(
    `mutation($cardId: ID!, $fieldId: ID!, $value: String!) {
      updateCardField(input: { card_id: $cardId, field_id: $fieldId, new_value: $value }) {
        card { id }
        success
      }
    }`,
    { cardId, fieldId, value: String(value ?? "") }
  );
  return data.updateCardField;
}

// Sincroniza uma lista de issues do Jira para o Pipefy (cria cards novos)
export async function syncIssuesToPipefy(issues) {
  const created = [];
  const errors = [];
  for (const issue of issues) {
    try {
      const card = await createCardFromIssue(issue);
      created.push({ jiraKey: issue.key, pipefyCardId: card.id, title: card.title });
    } catch (err) {
      errors.push({ jiraKey: issue.key, error: err.message });
    }
  }
  return { created, errors, total: issues.length };
}