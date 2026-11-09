# Notas de Release do Confluence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um botão "Notas de Release" na aplicação jira-tocantins que busque páginas do Confluence (REST API v2), salve em cache SQLite e exiba classificadas por versão e sistema.

**Architecture:** Backend consome Confluence REST API v2 (`src/confluence.js`), grava em tabela `release_notes` do SQLite existente, expõe endpoints `/api/release-notes`, `POST /api/release-notes/sync`, `GET /api/release-notes/status` (todos com `requireAuth`). Frontend (`public/index.html`) ganha botão e drawer com lista agrupada por sistema > versão.

**Tech Stack:** Node.js (ESM), Express, node:sqlite, fetch nativa, Confluence Cloud REST API v2, frontend vanilla JS/HTML inline.

**Spec:** `docs/superpowers/specs/2026-11-06-release-notes-confluence-design.md`

## Global Constraints

- Autenticação na API: Bearer token obrigatório (exceto `/api/health` e `/api/attachment/*`).
- `src/config.js` segue padrão `config.xxx`; adicionar seção `confluence` com `confluenceAuthHeader()` (Basic auth email:token).
- `src/users.js` já usa SQLite (`data/users.db`); reutilizar o mesmo `db` ou criar tabela nova no mesmo banco.
- Frontend é um único arquivo `public/index.html` (86KB, inline). Alterações minimizadas e consistentes com o estilo existente.
- CLAUDE.md: não criar docs desnecessários, validar input, não commitar secrets.
- Secrets do Confluence vão em `.env` (BASE_URL, EMAIL, TOKEN), nunca no código.
- Se Confluence não estiver configurado, endpoint retorna 503 com mensagem clara.

## Review Focus

| Input / condição | Comportamento esperado | Task que testa |
|------------------|------------------------|----------------|
| Confluence não configurado (sem email/token) | `GET /api/release-notes` retorna 503 com mensagem clara | Task 3 (endpoint status) |
| Página sem versão detectável no título | Agrupada sob "Sem versão" ou ignorada com log | Task 2 (parseReleaseNote) |
| Página duplicada (mesma confluence_page_id) | Atualiza registro existente (upsert), não duplica | Task 3 (sync) |
| Falha de rede/timeout na Confluence | Endpoint retorna erro 502, não derruba o servidor | Task 3 (fetchReleaseNotes) |
| Usuário não autenticado | Todos os endpoints `/api/release-notes/*` retornam 401 | Task 3 (requireAuth) |

---

### Task 1: Configuração Confluence e módulo de busca

**Files:**
- Create: `src/confluence.js`
- Modify: `src/config.js` (adicionar seção confluence + auth header)

**Interfaces:**
- Consumes: `config.confluence` (baseUrl, email, token, cql, limit)
- Produces: `fetchReleaseNotes()` → `Promise<Array<{id, title, url, spaceKey, spaceName, publishedAt, body}>>`; `confluenceAuthHeader()` → string Basic auth

- [ ] **Step 1: Escrever teste falhando para `confluenceAuthHeader`**

```js
import { confluenceAuthHeader } from "./confluence.js";
// ou importar de config se ficar lá
const header = confluenceAuthHeader("user@azi.com.br", "token123");
const expected = "Basic " + Buffer.from("user@azi.com.br:token123").toString("base64");
if (header !== expected) throw new Error("header incorreto");
```

- [ ] **Step 2: Executar teste, verificar que falha (módulo/função não existe)**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run src/confluence.test.js` (ou runner de teste do projeto)
Expected: FAIL — módulo ou função não encontrados

- [ ] **Step 3: Adicionar seção `confluence` a `src/config.js` e exportar `confluenceAuthHeader()`**

Em `src/config.js`, adicionar:
```js
confluence: {
  baseUrl: (process.env.CONFLUENCE_BASE_URL || "").replace(/\/$/, ""),
  email: process.env.CONFLUENCE_EMAIL || "",
  token: process.env.CONFLUENCE_TOKEN || "",
  cql: process.env.CONFLUENCE_CQL || 'type=page AND title ~ "Nota de Release"',
  limit: parseInt(process.env.CONFLUENCE_LIMIT || "50", 10),
},
```
e
```js
export function confluenceAuthHeader(email, token) {
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}
```

- [ ] **Step 4: Executar teste, verificar que passa**

Run: mesmo comando do Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/confluence.js
git commit -m "feat: configuração e auth do Confluence para notas de release"
```

---

### Task 2: Parser de página de release note

**Files:**
- Create: `src/confluence.js` (adicionar `parseReleaseNote`)
- Create: `tests/confluence.parse.test.js` (ou usar runner existente)

**Interfaces:**
- Consumes: objeto de página crua da Confluence (`{id, title, url, space: {key, name}, version: {when}, body.storage.value}`)
- Produces: `{ confluencePageId, title, version, system, spaceKey, spaceName, url, publishedAt, contentSummary }`

Regras de extração:
- Versão: regex no título, ex: `Nota de Release - 2.86.0-BETA`, `Notas de Release 6.33.0`, `Nota de Release - 2.17.0`. Captura padrão `X.Y.Z` com sufixo opcional `-BETA`, `-RC`, etc.
- Sistema: priorizar `space.name`; fallback: mapeamento de `space.key` (P3→Patrimônio Mobiliário, PI1→Patrimônio Intangível, CDMES→Catálogo de Materiais e Serviços, EDL→Edital, PDC→Plano de Compras, SP→(sistema não definido), AZ→(geração automática)).
- Se versão não detectar: `version = null` e agrupar sob "Sem versão".

- [ ] **Step 1: Escrever teste falhando para `parseReleaseNote`**

```js
import { parseReleaseNote } from "./confluence.js";
const page = {
  id: "3235643414",
  title: "Nota de Release - 2.86.0-BETA",
  url: "https://aztecnologia.atlassian.net/wiki/spaces/P3/pages/3235643414/...",
  space: { key: "P3", name: "Patrimônio Mobiliário" },
  version: { when: "2026-10-26T00:00:00.000Z" },
  body: { storage: { value: "<p>Resumo...</p>" } }
};
const r = parseReleaseNote(page);
if (r.version !== "2.86.0-BETA") throw new Error("versão errada: " + r.version);
if (r.system !== "Patrimônio Mobiliário") throw new Error("sistema errado: " + r.system);
if (r.confluencePageId !== "3235643414") throw new Error("id errado");
```

- [ ] **Step 2: Executar teste, verificar que falha**

Run: `node --experimental-vm-modules node_modules/.bin/vitest run tests/confluence.parse.test.js` (ou equivalente)
Expected: FAIL — função não existe

- [ ] **Step 3: Implementar `parseReleaseNote(page)` em `src/confluence.js`**

Implementar regex de versão e mapeamento de espaço→sistema.

- [ ] **Step 4: Executar teste, verificar que passa**

Run: mesmo comando do Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/confluence.js tests/confluence.parse.test.js
git commit -m "feat: parser de página de release note (versão e sistema)"
```

---

### Task 3: Tabela SQLite e endpoint de sync

**Files:**
- Modify: `src/users.js` (adicionar tabela release_notes no mesmo db, ou criar `src/release-notes.js`)
- Create: `src/release-notes.js` (opcional, se preferir separar)
- Modify: `src/server.js` (adicionar endpoints `GET /api/release-notes`, `POST /api/release-notes/sync`, `GET /api/release-notes/status`)

**Interfaces:**
- Consumes: `db` (DatabaseSync de users.js), `fetchReleaseNotes()` da Task 1, `parseReleaseNote()` da Task 2
- Produces: endpoints Express; funções `syncReleaseNotes()`, `listReleaseNotes({version, system, limit})`, `getReleaseNotesStatus()`

Decisão: criar `src/release-notes.js` com o `db` próprio (reusando padrão de `src/users.js`) e exportar `db`, `initReleaseNotesDB()`, `syncReleaseNotes()`, `listReleaseNotes()`, `getStatus()`. `src/server.js` importa e monta os endpoints.

- [ ] **Step 1: Escrever teste falhando para `initReleaseNotesDB` e `syncReleaseNotes` (mock de Confluence)**

```js
import { initReleaseNotesDB, syncReleaseNotes } from "./release-notes.js";
// init deve criar tabela; sync com fetch mocado deve gravar linhas
await initReleaseNotesDB();
const resultado = await syncReleaseNotes({ fetchPages: async () => [] }); // injetar fetch
if (!resultado) throw new Error("sync não retornou resultado");
```

- [ ] **Step 2: Executar teste, verificar que falha**

Run: runner de teste do projeto
Expected: FAIL — módulo não existe

- [ ] **Step 3: Criar `src/release-notes.js` com schema SQL, `initReleaseNotesDB()`, `upsertReleaseNote()`, `listReleaseNotes()`, `getStatus()`**

Schema:
```sql
CREATE TABLE IF NOT EXISTS release_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  confluence_page_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  version TEXT,
  system TEXT,
  space_key TEXT,
  space_name TEXT,
  url TEXT,
  published_at TEXT,
  synced_at TEXT NOT NULL,
  content_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_release_notes_version ON release_notes(version);
CREATE INDEX IF NOT EXISTS idx_release_notes_system ON release_notes(system);
```

- [ ] **Step 4: Implementar `syncReleaseNotes()` que chama `fetchReleaseNotes()`, parseia cada página, faz upsert no SQLite**

Usar `INSERT ... ON CONFLICT(confluence_page_id) DO UPDATE SET ...` para upsert.

- [ ] **Step 5: Executar teste, verificar que passa**

Run: mesmo comando do Step 2
Expected: PASS

- [ ] **Step 6: Adicionar endpoints em `src/server.js`**

```js
app.get("/api/release-notes", requireAuth, async (req, res) => { ... listReleaseNotes ... });
app.post("/api/release-notes/sync", requireAuth, async (req, res) => { ... syncReleaseNotes ... });
app.get("/api/release-notes/status", requireAuth, async (req, res) => { ... getStatus ... });
```

Se Confluence não configurado (sem email/token), retornar 503.

- [ ] **Step 7: Executar teste de integração dos endpoints (ou iniciar servidor e fazer curl)**

Expected: endpoints respondem 200 (ou 503 se não configurado), 401 sem token

- [ ] **Step 8: Commit**

```bash
git add src/release-notes.js src/server.js
git commit -m "feat: cache SQLite e endpoints de notas de release"
```

---

### Task 4: Frontend — botão e drawer de notas de release

**Files:**
- Modify: `public/index.html` (adicionar botão, drawer/modal, renderização da lista)

**Interfaces:**
- Consumes: `GET /api/release-notes`, `POST /api/release-notes/sync` (com Bearer token da sessão atual)
- Produces: UI que exibe lista agrupada por sistema > versão, com link para Confluence e botão "Sincronizar"

- [ ] **Step 1: Escrever teste de UI (ou verificar manualmente) — botão existe no DOM**

Após carregar `public/index.html`, deve existir botão com texto "Notas de Release".

- [ ] **Step 2: Verificar que o botão não existe ainda (antes da modificação)**

Expected: não há botão "Notas de Release" no HTML atual

- [ ] **Step 3: Adicionar botão "Notas de Release" no dashboard de `public/index.html`**

Colocar ao lado dos outros botões de ação (área de KPIs/actions), consistente com o estilo existente (classes CSS já usadas no arquivo).

- [ ] **Step 4: Adicionar drawer/modal de notas de release (oculto por padrão)**

Container com lista vazia, estado de carregamento, erro, e botão "Sincronizar agora".

- [ ] **Step 5: Implementar fetch e renderização**

- `GET /api/release-notes` com token da sessão (mesmo padrão de `fetch` usado em outros endpoints do frontend).
- Agrupar por `system`, ordenar versões decrescentes dentro de cada grupo.
- Cada item: versão, data, sistema, resumo, link "Abrir no Confluence".
- Se vazio: mostrar botão "Sincronizar agora" que chama `POST /api/release-notes/sync`.

- [ ] **Step 6: Verificação manual — abrir o app, clicar no botão, confirmar drawer abre e lista renderiza (ou estado vazio com botão sync)**

Expected: sem erros de console, drawer abre, requisição à API com Bearer token

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: botão e drawer de notas de release no frontend"
```

---

### Task 5: Variáveis de ambiente e documentação de uso

**Files:**
- Modify: `.env.example` (adicionar variáveis Confluence)

**Interfaces:**
- Produces: exemplo de `.env` com `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN`, `CONFLUENCE_CQL`, `CONFLUENCE_LIMIT`

- [ ] **Step 1: Adicionar seção Confluence a `.env.example`**

```ini
# ===== Confluence (Notas de Release) =====
CONFLUENCE_BASE_URL=https://aztecnologia.atlassian.net/wiki
CONFLUENCE_EMAIL=usuario@empresa.com
CONFLUENCE_TOKEN=seu-api-token-do-confluence
CONFLUENCE_CQL=type=page AND title ~ "Nota de Release"
CONFLUENCE_LIMIT=50
```

- [ ] **Step 2: Verificar que `.env.example` contém as novas variáveis e nenhum valor real de produção**

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat: variáveis de ambiente do Confluence no .env.example"
```

---

## Self-review do plano

1. **Spec coverage:** Todos os requisitos do design doc (config, módulo Confluence, parser, SQLite, 3 endpoints, frontend botão+drawer, .env.example) têm tasks dedicadas. Não há gaps.
2. **Step scan:** Cada step permite escrever exatamente uma coisa razoável; nenhum step carrega mais que isso. Não há linhas "TBD" ou "handle edge cases" sem teste associado.
3. **Type consistency:** `fetchReleaseNotes()` (Task 1) → consumido por `syncReleaseNotes()` (Task 3). `parseReleaseNote()` (Task 2) → consumido por `syncReleaseNotes()` (Task 3). Endpoints (Task 3) → consumidos pelo frontend (Task 4). Nomes e assinaturas são consistentes entre tasks.
4. **Review Focus:** Cada linha da tabela Review Focus tem mapeamento para uma task (Confluence não configurado → Task 3; página sem versão → Task 2; duplicata → Task 3; falha de rede → Task 3; não autenticado → Task 3).
5. **Proportion:** O plano tem ~30 steps para ~7 arquivos alterados/criados. Proporcional ao escopo; não é transcrição do código.

---

**Plano completo e salvo em** `docs/superpowers/plans/2026-11-06-release-notes-confluence.md`.

Você ainda não definiu um método de execução. Qual abordagem prefere?

- **Subagent-driven** — Um subagent implementa cada task e um revisor fresco confere antes da próxima; revisão de branch ao final. Mais completo; custo de contexto fresco por task e por revisão.
- **Native** — Eu implemento todas as tasks nesta sessão, e um revisor fresco confere a branch inteira ao final. Mais rápido e barato; revisão independente só no final.

**O plano captura o que você quer? Qual abordagem de execução devemos usar?**
