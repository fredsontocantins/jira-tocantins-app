# Implementation Plan — Improvements from jiraaberto.zip Analysis

## Overview
The current `jira-tocantins-app` is more robust (auth, Pipefy, cache, scope, graphs, PDF) but the `jiraaberto.zip` has refined UX and backend patterns. This plan extracts selective improvements from the zip while preserving existing differentiators.

**Strategy:** Extract patterns from zip → port to current architecture → maintain auth/Pipefy/graphs/PDF.

---

## Phase A — Quick Wins (1-2 days)
_P0: High impact / low effort_

| # | Improvement | Files | Effort |
|---|-----------|-------|--------|
| 1 | Add `AbortSignal.timeout(30000)` in `src/jira.js` | `src/jira.js` | Baixo |
| 2 | HTTP error status handling (401/403/404/429) with friendly messages | `src/jira.js`, `src/server.js` | Baixo |
| 3 | Project key validation (`/^[A-Za-z0-9_]+$/`) in `/api/jql` and `/api/chamados/abertos` | `src/server.js` | Baixo |
| 4 | Debounce search in frontend (450 ms) instead of reload per keystroke | `public/index.html` | Baixo |
| 5 | Keyboard shortcuts `/` (focus search) and `Esc` (clear) | `public/index.html` | Baixo |

### Phase A Tasks:
- [ ] **Task A1:** Add `AbortSignal.timeout(30000)` to `jiraFetch` in `src/jira.js` (already partially present — ensure full signal cleanup)
- [ ] **Task A2:** Add HTTP status-based error messages in `jiraFetch` error handling (401/403/404/429)
- [ ] **Task A3:** Ensure `validProjectKey` validation runs in both `/api/chamados/abertos` and `/api/jql` endpoints
- [ ] **Task A4:** Implement debounce for `searchInput` in `public/index.html` (450ms delay before search fetch)
- [ ] **Task A5:** Add keyboard shortcuts: `Focus()` → focus search input, `Esc` → clear search and reset

---

## Phase B — P1 Improvements (3-5 days)
_P1: High impact / medium effort_

| # | Improvement | Files | Effort |
|---|-----------|-------|--------|
| 6 | Progressive pagination with `nextPageToken` on `/api/chamados/abertos` or new `/api/issues` + "Carregar mais" button | `src/jira.js`, `src/server.js`, `public/index.html` | Médio |
| 7 | Server-side search with `text ~` and Jira key detection (`key = "..."`) | `src/jira.js` | Médio |
| 8 | Server-side sorting (`ORDER BY`) for consistency | `src/jira.js` | Médio |
| 9 | Expose custom fields + `names` in issue detail (`fields=*all`, `expand=names,renderedFields`) | `src/jira.js` (`fetchIssueDetails`) | Médio |
| 10 | Unified timeline (comments + worklogs + changelog) ordered by recency, with activity pagination | Frontend + `/api/issue/:key` | Médio |
| 11 | Distinction public comment vs internal note (JSM `jsdPublic` / `sd.public.comment`) | `src/jira.js` (`normalizeComment`) | Médio |
| 12 | Unified attachment proxy with inline/attachment by MIME (`image/*` inline) | `src/server.js` | Baixo-Médio |

### Phase B Tasks:
- [ ] **Task B1:** Implement `searchIssues` with `nextPageToken` support — return `{ issues, nextPageToken, isLast, total }`; update `/api/chamados/abertos` and `/api/issues` endpoints
- [ ] **Task B2:** Add server-side `text ~` search and Jira key detection (`/^[A-Za-z][A-Za-z0-9_]*-\d+$/` → `key = "..."`) in `searchIssues` 
- [ ] **Task B3:** Ensure `sort` parameter uses server-side `ORDER BY` via `SORT_MAP` in `searchIssues`
- [ ] **Task B4:** Update `fetchIssueDetails` to use `fields=*all` and `expand=names,renderedFields`; expose `customFields` with `label` from `data.names`
- [ ] **Task B5:** Implement unified activity timeline — combine comments + worklogs + changelog histories ordered by `created` descending, with pagination
- [ ] **Task B6:** Implement `commentVisibility` detection: `jsdPublic` + `sd.public.comment` property → classify as "public" or "internal"
- [ ] **Task B7:** Unify attachment proxy — ensure `image/*` MIME types get `Content-Disposition: inline`, others `attachment`

---

## Phase C — P2 Improvements (1-2 weeks)
_P2: Medium impact / greater effort_

| # | Improvement | Files | Effort |
|---|-----------|-------|--------|
| 13 | Separate frontend into `index.html` + `app.js` + `styles.css` (currently 86 KB inline) | `public/` | Alto |
| 14 | Layout with sidebar + topbar + metrics (inspired by zip) keeping current charts | `public/index.html` | Alto |
| 15 | "O que aconteceu" section + custom fields collapsible "Dados completos" + labels/components as tags | Frontend | Médio |
| 16 | Project search autocomplete in seletor | Frontend | Médio |
| 17 | Make table rows clickable to open detail | Frontend | Baixo |
| 18 | Project pagination (`project/search` with `startAt`) | `src/jira.js` (`fetchProjects`) | Baixo |

### Phase C Tasks:
- [ ] **Task C1:** Split `public/index.html` into three files: `index.html` (structure), `app.js` (logic), `styles.css` (styles)
- [ ] **Task C2:** Implement sidebar layout with topbar, project selector with "Todos os projetos" search, and metrics section (total, high/critical, unresponsible, projects) — inspired by zip but keeping Chart.js graphs
- [ ] **Task C3:** Add "O que aconteceu" preservation section, custom fields collapsible container ("Dados completos"), labels/components as visual tags
- [ ] **Task C4:** Implement project search autocomplete (autocomplete API call as user types, "Todos os projetos" option)
- [ ] **Task C5:** Make table rows clickable (`data-key` → open issue drawer) — currently only key is clickable
- [ ] **Task C6:** Add pagination to `/api/projects` using `startAt`/`maxResults` with ordering by name pt-BR

---

## Phase D — P3 Nice-to-Have (contínuo)
_P3: Nice-to-have_

| # | Improvement | Effort |
|---|-----------|--------|
| 19 | Reuse zip's "Raio-X" visual as alternative to current drawer (modal wider) | Médio |
| 20 | Expose `renderedFields` for HTML description rendering (vs plain text) | Médio |
| 21 | Automated tests of endpoints | Alto |

---

## API Compatibility Notes
- `/api/chamados/abertos` and `/api/jql` are used by external consumers → pagination changes must not break current format
  - Keep `data` as array; add optional `nextPageToken`, `isLast`, `total` fields
- New endpoints (`/api/issues`) follow zip style but old endpoints remain for compatibility
- All new endpoints must pass through `requireAuth`/`requireProjectScope`/`issueProjectGuard`
- Do NOT replicate the zip's open API (no auth) — maintain Bearer token + scope

---

## Security & Performance
- Avoid N+1: don't fetch issue details on every list item — use on-demand (same pattern as zip)
- Cache pagination with `nextPageToken` in cache key
- Rate limit protection: `AbortSignal.timeout(30000)` + 429 handling
- Maintain scope per user — any new endpoint must pass `requireProjectGuard`

---

## Rollback Strategy
- Keep old endpoints (`/api/chamados/abertos` without pagination) functional during Phase B
- Feature flags can be added via query params (e.g., `?usePagination=true`) if needed
- All changes are additive — no existing behavior is removed, only enhanced