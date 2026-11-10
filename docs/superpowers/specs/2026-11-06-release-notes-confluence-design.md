# Design: Botão "Notas de Release" do Confluence (B + C)

**Data:** 2026-11-06  
**Projeto:** jira-tocantins-app  
**Autor:** agente (superpowers)  
**Status:** pendente de aprovação do humano

---

## 1. Intent e por que

O usuário quer um botão na aplicação que busque as "Notas de Release" do Confluence da Az Tecnologia (`aztecnologia.atlassian.net`) e exiba classificadas por **versão** e por **sistema**.

Hoje as notas de release estão espalhadas em páginas do Confluence (vários espaços: P3, PI1, CDMES, EDL, PDC, SP, AZ). A busca TWG já encontrou dezenas delas. O objetivo é trazer esse conteúdo para dentro do app jira-tocantins, com um botão dedicado na UI.

Escolhida a abordagem **B + C**:
- **B**: backend consome a Confluence REST API diretamente (não depende da CLI `twg` no servidor de produção).
- **C**: sincronização periódica/sob demanda com cache local no SQLite (já existe `src/users.js` com SQLite), para leitura rápida e classificação offline.

---

## 2. Goals

- [ ] Botão na UI (frontend `public/index.html`) que abre uma tela/painel de "Notas de Release".
- [ ] Backend endpoint `/api/release-notes` (ou similar) que lê do cache SQLite e/ou dispara sincronização.
- [ ] Módulo `src/confluence.js` que consulta a Confluence REST API v2 (busca CQL por páginas com "Nota de Release" no título).
- [ ] Sincronização: endpoint `POST /api/release-notes/sync` (requer auth) que baixa páginas do Confluence e grava no SQLite.
- [ ] Classificação automática por **versão** (extraída do título/conteúdo, ex: 2.86.0-BETA, 6.33.0, 5.10.13) e por **sistema** (extraído do espaço Confluence ou do conteúdo, ex: Patrimônio Mobiliário, Setup, Flowbee).
- [ ] Listagem ordenada (versão decrescente), agrupada por sistema.
- [ ] Autenticação obrigatória na API (Bearer token, consistente com o resto do app).
- [ ] Não commitar secrets (regras do CLAUDE.md): credenciais do Confluence vão em `.env`, nunca no código.

## 3. Non-goals

- Não é gerar release notes automaticamente (a página do Confluence "Geração Automática de Release Notes com Claude AI" já trata disso).
- Não é editar/criar páginas no Confluence (apenas leitura).
- Não é substituir o Jira — as notas de release vêm do Confluence, não de issues do Jira (embora algumas issues do Jira também tenham dados de liberação; ficar para fase futura).
- Não é exportação PDF das notas de release (pode vir depois).

## 4. Anti-goals (o que seria um fracasso mesmo que funcione)

- Exigir que o usuário instale a CLI `twg` no servidor de produção.
- Armazenar token do Confluence em código-fonte ou no banco em texto plano sem variável de ambiente.
- Quebrar endpoints existentes do Jira/Pipefy.
- Exigir nova autenticação separada do Confluence para o usuário final (reusa a sessão já autenticada do app).

## 5. Constraints

- Autenticação na API: Bearer token obrigatório (exceto `/api/health` e `/api/attachment/*`).
- `src/config.js` já existe com padrão `config.xxx`; adicionar `confluence` lá.
- `src/users.js` já usa SQLite (`data/users.db`); reutilizar o mesmo `db` ou criar tabela nova no mesmo banco.
- Frontend é um único arquivo `public/index.html` (86KB, inline). Alterações devem ser minimizadas e consistentes com o estilo existente.
- CLAUDE.md: não criar docs desnecessários, validar input, não commitar secrets.
- Confluence Cloud REST API v2 exige Basic Auth (email + API token) ou Bearer (PAT). Usar email + token (mesmo padrão do Jira).

## 6. Approaches consideradas

| Abordagem | Prós | Contras | Veredito |
|-----------|------|---------|----------|
| **A** — Chamar CLI `twg` via shell do backend | Sem novas credenciais, usa sessão twg já autenticada | Depende do `twg` instalado no servidor de produção; parse de JSON frágil; não é "integração direta" | Descartada (usuário escolheu B+C) |
| **B** — Confluence REST API direta no backend | Integração nativa, sem dependência externa de CLI, controle total | Precisa de credenciais do Confluence (email + token) em `.env` | Escolhida (parte B) |
| **C** — Cache local SQLite + sync | Leitura rápida, funciona offline, classificação pré-computada | Precisa de job/endpoint de sync; dados podem ficar desatualizados entre syncs | Escolhida (parte C) |

**Escolhida: B + C.** Backend consome Confluence REST API (B) e grava num cache SQLite com endpoint de sync sob demanda (C).

---

## 7. Como será construído (partes decididas)

### 7.1 Configuração (`src/config.js`)
Adicionar seção `confluence`:
```js
confluence: {
  baseUrl: process.env.CONFLUENCE_BASE_URL || "",           // https://aztecnologia.atlassian.net/wiki
  email: process.env.CONFLUENCE_EMAIL || "",
  token: process.env.CONFLUENCE_TOKEN || "",                 // API token do Confluence
  cql: process.env.CONFLUENCE_CQL || 'type=page AND title ~ "Nota de Release"',
  limit: parseInt(process.env.CONFLUENCE_LIMIT || "50", 10),
},
```
Adicionar helpers `confluenceAuthHeader()` (Basic auth email:token).

### 7.2 Novo módulo `src/confluence.js`
- `fetchReleaseNotes()`: chama `GET /wiki/rest/api/content/search?cql=...&limit=...&expand=body.storage,version,space` e retorna lista de páginas cruas.
- `parseReleaseNote(page)`: extrai versão (regex no título: `Nota de Release - X.Y.Z` ou `Notas de Release X.Y.Z`), sistema (do `space.name` ou mapeamento de espaço→sistema), data, URL, conteúdo resumido.
- `syncReleaseNotes()`: busca todas as páginas (com paginação), parseia cada uma, grava/atualiza no SQLite.

### 7.3 Banco de dados (SQLite, reusando `src/users.js` ou novo módulo `src/release-notes.js`)
Tabela nova `release_notes`:
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

### 7.4 Endpoints API (`src/server.js`)
- `GET /api/release-notes` — `requireAuth`. Retorna notas do cache SQLite, com filtros opcionais `?version=`, `?system=`, `?limit=`. Ordenado por versão decrescente, agrupado por sistema.
- `POST /api/release-notes/sync` — `requireAuth` (ou `requireAdmin`). Dispara sincronização do Confluence para o SQLite. Retorna contador de sincronizadas/atualizadas/erros.
- `GET /api/release-notes/status` — `requireAuth`. Retorna se há configuração Confluence, última sincronização, contagem.

Se Confluence não estiver configurado (sem email/token), o endpoint retorna 503 com mensagem clara.

### 7.5 Frontend (`public/index.html`)
- Adicionar botão "Notas de Release" no dashboard (ao lado dos outros botões de ação, na área de KPIs/actions).
- Ao clicar, abrir um drawer/modal (consistente com o drawer de detalhe existente) ou navegar para uma seção da mesma página (single-page app já existente).
- Exibir lista agrupada por sistema, dentro de cada sistema lista por versão decrescente.
- Cada item mostra: versão, data, sistema, resumo do conteúdo, link para abrir a página no Confluence.
- Se não houver dados, mostrar botão "Sincronizar agora" que chama `POST /api/release-notes/sync`.

### 7.6 Variáveis de ambiente (`.env.example`)
Adicionar:
```
# ===== Confluence (Notas de Release) =====
CONFLUENCE_BASE_URL=https://aztecnologia.atlassian.net/wiki
CONFLUENCE_EMAIL=usuario@empresa.com
CONFLUENCE_TOKEN=seu-api-token-do-confluence
CONFLUENCE_CQL=type=page AND title ~ "Nota de Release"
CONFLUENCE_LIMIT=50
```

---

## 8. O que fica para o builder decidir (durante a implementação)

- Se o drawer/modal do frontend reusa o componente de drawer existente ou cria um novo container inline.
- Se a sincronização é apenas sob demanda (endpoint POST) ou também há um intervalo automático (setInterval no servidor). Recomendo: sob demanda + opcional intervalo configurável.
- Se a classificação por "sistema" usa apenas o `space_name` do Confluence ou tenta extrair do conteúdo da página (ex: "Produto: Patrimônio Mobiliário").
- Como tratar páginas sem versão detectável no título (agrupar sob "Sem versão" ou ignorar).

---

## 9. Próximo passo

Após sua aprovação deste design doc, invoco `superpowers:writing-plans` para gerar o plano de tarefas, depois `subagent-driven-development` + `test-driven-development` para implementar.

**Confirma a aprovação deste design?** Se houver algo a ajustar, diga agora antes de prosseguir para o plano.
