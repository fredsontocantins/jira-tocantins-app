# Análise de Melhorias — jira-tocantins-app vs. `jiraaberto.zip`

> Referência analisada: `/home/casa/Downloads/jiraaberto.zip` descompactado em `/tmp/opencode/jiraaberto`.
> App atual: `/home/casa/jira-tocantins-app`.
> Data: 2026-10-23.

## 1. Resumo executivo

O zip (`painel-chamados-abertos`) é um painel **alternativo e mais polido** para o mesmo problema (chamados Jira em aberto), construído como app standalone (HTTP nativo, sem Express) com frontend moderno (sidebar, métricas, filtros por projeto, busca com debounce, ordenação por coluna, paginação progressiva via `nextPageToken`, dialog de "Raio-X" do chamado com descrição, campos customizados, etiquetas/componentes, anexos, timeline unificada de comentários + worklogs + histórico). Ele foi gerado por uma ferramenta (Manus) e contém um `TODO.md` com checklist de features concluídas.

A nossa app (`jira-tocantins-app`) é **mais completa como produto/integração**: autenticação por usuários, escopo de projetos por usuário, cache em memória, integração Pipefy (sync + webhook), endpoints de atividade recente, análise de chamado (intenção do cliente vs. suporte), proxy de anexos com thumbnail, JQL customizado, Docker. Porém o frontend é um monolito de 86 KB em um único `index.html`, com UX menos refinada em vários pontos (busca, paginação, detalhe do chamado).

**Conclusão:** não substituir a nossa app pelo zip. Adotar seletivamente do zip padrões de UX e de backend que melhoram a experiência, mantendo nossos diferenciais (auth, Pipefy, escopo, integração externa).

## 2. Comparativo de arquitetura

| Aspecto | jira-tocantins-app (atual) | painel-chamados-abertos (zip) | Veredito |
|---|---|---|---|
| Backend | Express 4, modular (config/auth/jira/pipefy) | `http` nativo, monolítico (`server.js` + `jira.js`) | Manter Express; modularidade é superior |
| Auth | Usuários fixos + tokens em memória (12h), escopo por projeto | Nenhuma (API aberta) | **Manter** — segurança |
| Credenciais Jira | `JIRA_DOMAIN/EMAIL/TOKEN` (configurável) | Hardcoded `https://aztecnologia.atlassian.net`, `ATLASSIAN_EMAIL/TOKEN` | **Não adotar** hardcoded; manter configurável |
| Cache | Map em memória TTL 60s (chamados), 300s (projetos), 120s (atividades) | Nenhum | **Manter** |
| Paginação | `fetchIssuesByJql` agrega todas as páginas até `maxResults` (até 100) | `nextPageToken` progressivo, lotes de 100, "Carregar mais" | **Adotar progressivo** (UX + menos carga) |
| Busca | JQL no backend; frontend filtra client-side | Debounce 450ms + `text ~` / `key =` no Jira | **Adotar debounce server-side** |
| Ordenação | Client-side (atualizado, key, project, priority) | Server-side `ORDER BY` + client-side re-sort | Híbrido OK; manter |
| Projetos | Lista + filtro por sessão | Lista + seletor "Todos os projetos" | **Adotar UX** (busca de projeto) |
| Detalhe do chamado | Drawer + Raio-X modal (histórico, comentários, worklogs, anexos, análise) | Dialog modal com campos customizados, etiquetas/componentes, timeline unificada, distinção público/interno | **Adotar campos customizados + timeline unificada + público/interno** |
| Anexos | Proxy com thumbnail + download | Proxy por id (`/api/attachments/:id`) com inline/attachment | Equivalente |
| Integração externa | Pipefy (sync, cards, webhook) + JQL genérico | Nenhuma | **Manter** (diferencial) |
| Docker | Compose com HOST_PORT | Dockerfile alpine | Manter compose |
| Frontend | Monolito 86 KB (HTML+CSS+JS inline) | 3 arquivos separados (index.html, app.js, styles.css) | **Adotar separação** (manutenibilidade) |

## 3. O que o zip faz melhor (candidatos a adoção)

### 3.1 Backend / API

1. **Paginação progressiva via `nextPageToken`** (`searchIssues` retorna `{ issues, nextPageToken, isLast, total }`). Hoje `fetchIssuesByJql` puxa tudo de uma vez (até `maxResults`), o que é lento e pesado quando há muitos chamados. Adotar paginação no endpoint `/api/chamados/abertos` (ou novo `/api/issues`) com `?nextPageToken=...` e botão "Carregar mais".
2. **Busca no Jira com `text ~` e detecção de chave** (`/^[A-Za-z][A-Za-z0-9_]*-\d+$/` → `key = "..."`). Evita carregar tudo e filtrar no cliente. Debounce no frontend (450 ms).
3. **Ordenação server-side** (`updated DESC`, `created DESC`, `priority ASC`, `key ASC`, `project ASC`) reduz trabalho no cliente e é consistente.
4. **`/api/projects` com paginação** (`project/search` com `startAt`/`maxResults`) e ordenação por nome pt-BR.
5. **Detalhe com `fields=*all` + `expand=names,renderedFields`** para capturar **campos customizados preenchidos** e nomes amigáveis. Hoje `fetchIssueDetails` pede campos explícitos e não expõe custom fields nem `names`.
6. **Timeline unificada** (comentários + worklogs + changelog) ordenada por recência decrescente, com paginação de atividade (`fetchAllPages`).
7. **Distinção comentário público vs. nota interna** (Jira Service Management): `jsdPublic` / propriedade `sd.public.comment`. Útil para identificar interações com cliente.
8. **Proxy de anexo com `Content-Disposition` inline vs. attachment** baseado em MIME (`image/png|jpeg|gif|webp` inline). Hoje quase equivalente, mas vale unificar.
9. **Validação de `projectKey`** (`/^[A-Za-z0-9_]+$/`) antes de consultar.
10. **Tratamento de erros por status HTTP** (401/403/404/429) com mensagens amigáveis e `AbortSignal.timeout(30000)`.

### 3.2 Frontend / UX

1. **Layout com sidebar + topbar + métricas** (mais moderno que o header único atual). O zip tem ` Visão geral / Chamados` na sidebar e indicadores (total, prioridade alta/crítica, sem responsável, projetos).
2. **Filtro por projeto com "Todos os projetos"** + busca de projeto (hoje só select com "Tocantins (TO)" e "Todos").
3. **Busca com atalho `/`** para focar e `Esc` para limpar (atalhos de teclado).
4. **Tabela clicável na linha** para abrir detalhe (hoje precisa clicar no ícone).
5. **Dialog modal "Raio-X"** em vez de drawer lateral — mais espaço para descrição longa e timeline. (Avaliar: pode coexistir com drawer atual.)
6. **Seção "O que aconteceu"** preservando a descrição original do pedido (já temos parcialmente).
7. **Campos customizados preenchidos** em `<details>` colapsável ("Dados completos") — hoje não mostramos.
8. **Etiquetas e componentes** como tags visuais.
9. **Timeline unificada** com marcadores por tipo (comentário, worklog, alteração) e autor/data.
10. **Estados explícitos**: loading, lista vazia, erro de consulta (mensagens compreensíveis).
11. **Paginação progressiva** com "Carregar mais chamados" e contador "Exibindo X de Y".
12. **Separação de arquivos** (`index.html`, `app.js`, `styles.css`) — hoje tudo inline em 86 KB. Facilita manutenção e cache.

### 3.3 Pequenos detalhes de qualidade

- `escapeHtml` consistente (já temos).
- `niceDate` com "há X min/h" e data formatada pt-BR (já temos similar).
- `AbortSignal.timeout` em chamadas Jira (hoje não temos timeout explícito em `jiraFetch`).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy` nos estáticos (já temos parcialmente).

## 4. O que NÃO adotar do zip (regressões / riscos)

1. **Sem autenticação** — inaceitável para o nosso contexto (temos usuários `tocantins`/`operacoes` com escopo).
2. **Credenciais hardcoded** (`JIRA_ORIGIN = 'https://aztecnologia.atlassian.net'`) — perderíamos configurabilidade multi-tenant.
3. **Monolito backend** sem Express — perderíamos middlewares, CORS, cache centralizado, integração Pipefy.
4. **Sem integração Pipefy** — perderíamos o diferencial de sync/webhook.
5. **Sem cache** — mais chamadas ao Jira, risco de rate limit (429).
6. **Sem análise de chamado** (intenção do cliente vs. suporte, transições) — já temos `/api/issue/:key/analysis`, superior.
7. **Sem atividade recente agregada** (`/api/atividades`) — já temos.
8. **Sem escopo por projeto no usuário** — já temos `requireProjectScope`/`issueProjectGuard`.
9. **Frontend sem gráficos/KPIs avançados** — o nosso dashboard tem Chart.js (status, prioridade, tipo, responsável, timeline). O zip não tem gráficos. Manter os nossos.
10. **Sem exportação PDF** — o nosso tem jsPDF/html2canvas. Manter.

## 5. Melhorias priorizadas

### P0 — Alto impacto / baixo esforço (fazer já)

| # | Melhoria | Onde | Esforço |
|---|---|---|---|
| 1 | Adicionar `AbortSignal.timeout(30000)` em `jiraFetch` | `src/jira.js` | Baixo |
| 2 | Tratamento de erros por status HTTP (401/403/404/429) com mensagens amigáveis | `src/jira.js` | Baixo |
| 3 | Validação de `projectKey` (`/^[A-Za-z0-9_]+$/`) em `/api/jql` e `/api/chamados/abertos` | `src/server.js` | Baixo |
| 4 | Debounce de busca no frontend (450 ms) em vez de recarregar a cada tecla | `public/index.html` | Baixo |
| 5 | Atalhos de teclado `/` (focar busca) e `Esc` (limpar) | `public/index.html` | Baixo |

### P1 — Alto impacto / médio esforço

| # | Melhoria | Onde | Esforço |
|---|---|---|---|
| 6 | Paginação progressiva com `nextPageToken` no backend (`/api/issues` ou estender `/api/chamados/abertos`) + botão "Carregar mais" | `src/jira.js`, `src/server.js`, frontend | Médio |
| 7 | Busca server-side com `text ~` e detecção de chave Jira (`key =`) | `src/jira.js` | Médio |
| 8 | Ordenação server-side (`ORDER BY`) para consistência | `src/jira.js` | Médio |
| 9 | Expor campos customizados + `names` no detalhe (`fields=*all`, `expand=names,renderedFields`) | `src/jira.js` (`fetchIssueDetails`) | Médio |
| 10 | Timeline unificada (comentários + worklogs + changelog) ordenada por recência, com paginação de atividade | frontend + `/api/issue/:key` | Médio |
| 11 | Distinção comentário público vs. nota interna (JSM) | `src/jira.js` (`normalizeComment`) | Médio |
| 12 | Proxy de anexo unificado com inline/attachment por MIME | `src/server.js` | Baixo-Médio |

### P2 — Médio impacto / maior esforço

| # | Melhoria | Onde | Esforço |
|---|---|---|---|
| 13 | Separar frontend em `index.html` + `app.js` + `styles.css` (hoje 86 KB inline) | `public/` | Alto |
| 14 | Layout com sidebar + topbar + métricas (inspirado no zip) mantendo gráficos atuais | `public/index.html` | Alto |
| 15 | Seção "O que aconteceu" + campos customizados colapsáveis + etiquetas/componentes como tags | frontend | Médio |
| 16 | Busca de projeto no seletor (autocomplete) | frontend | Médio |
| 17 | Tornar linhas da tabela clicáveis para abrir detalhe | frontend | Baixo |
| 18 | Paginação de projetos (`project/search` com `startAt`) | `src/jira.js` (`fetchProjects`) | Baixo |

### P3 — Nice-to-have

| # | Melhoria | Esforço |
|---|---|---|
| 19 | Reaproveitar o visual "Raio-X" do zip como alternativa ao drawer atual (modal mais largo) | Médio |
| 20 | Expor `renderedFields` para renderizar descrição em HTML (em vez de texto puro) | Médio |
| 21 | Testes automatizados de endpoints (hoje não há suite de testes) | Alto |

## 6. Quick wins (posso implementar agora)

1. Timeout + erros amigáveis em `src/jira.js`.
2. Validação de `projectKey` em `src/server.js`.
3. Debounce + atalhos de teclado no frontend.
4. Paginação de projetos.

## 7. Roadmap sugerido (fases)

- **Fase A (1-2 dias):** P0 (itens 1-5) + itens 17, 18 (quick wins). Sem mudanças de contrato de API.
- **Fase B (3-5 dias):** P1 (itens 6-12). Introduz paginação progressiva e busca server-side; manter endpoints antigos por compatibilidade.
- **Fase C (1-2 semanas):** P2 (itens 13-16). Refatoração do frontend; manter paridade de features (gráficos, PDF, auth).
- **Fase D (contínuo):** P3 + testes automatizados + monitoramento de rate limit.

## 8. Riscos e considerações

- **Compatibilidade com consumidores externos:** `/api/chamados/abertos` e `/api/jql` são usados por outros sistemas. Mudanças de paginação não devem quebrar o formato atual (manter `data` como array; adicionar campos opcionais `nextPageToken`, `isLast`).
- **Cache:** paginação progressiva pode invalidar cache por página; usar chave de cache incluindo `nextPageToken`.
- **Auth/escopo:** qualquer novo endpoint deve passar por `requireAuth`/`requireProjectScope`/`issueProjectGuard`, como os existentes.
- **Performance:** evitar N+1 (ex.: buscar detalhe de cada issue na listagem). O zip busca detalhe on-demand no dialog — adotar o mesmo padrão.
- **Segurança:** não replicar a API aberta do zip; manter Bearer token + escopo.

## 9. Conclusão

A nossa app é **mais robusta e integrada**; o zip é **mais refinado em UX e em detalhes de backend** (paginação, busca, campos customizados, timeline, público/interno). A estratégia recomendada é **extrair padrões do zip e portá-los para a nossa arquitetura**, sem substituir o que já temos de superior (auth, Pipefy, gráficos, análise, atividade, PDF, Docker).

Se quiser, posso começar pela **Fase A (quick wins)** agora.