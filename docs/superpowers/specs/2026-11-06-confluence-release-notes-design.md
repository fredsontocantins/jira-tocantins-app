# Design — Busca e Export de Notas de Release Confluence

## Contexto
App jira-tocantins-app possui menu "Nota de Release" que busca apenas em espaços fixos PI1/P3 via TWG. Usuário solicitou busca em **todos os espaços Confluence** que contenham Notas de Release, leitura do conteúdo e export no padrão da empresa.

Padrão de export observado em `/home/casa/Downloads/GER 1.9.3.md`:
```
# GER 1.9.3
# Nota de Release — v1.9.3
**Data de publicação:** 
## 1. Correções realizadas
| Ticket | Descrição |
...
```
Título do sistema + versão, subtítulo Nota de Release, data, tabela de correções com ticket Jira e descrição estruturada.

## Objetivo
Descobrir páginas de Nota de Release em todos os espaços Confluence, ler conteúdo completo via TWG e disponibilizar visualização e exportação no padrão Markdown da empresa.

## Escopo
- Busca CQL sem restrição de espaço: `type=page AND title ~ "Nota de Release"`
- Filtros opcionais: versão/termo no título, módulo no texto
- Leitura de conteúdo via `twg confluence content get <id> --format html`
- Normalização para Markdown no padrão GER
- UI de busca, preview e export .md
- Não incluir armazenamento persistente no MVP

## Arquitetura

### Backend
**src/server.js**
- `/api/release/search?term=&module=&space=`
  - Monta CQL:
    ```
    type=page AND title ~ "Nota de Release"
    [AND title ~ "<term>"]
    [AND text ~ "<module>"]
    [AND space = "<space>"]
    lastmodified >= now("-365d")
    ```
  - Executa `twg confluence search query --cql "<cql>" --limit 50 --output json`
  - Extrai id, title, spaceKey, url, lastModified
  - Extrai versão do título via regex `/(?:v)?(\d+\.\d+(?:\.\d+)?[A-Z0-9\.\-]*)`
  - Retorna `{success:true, items:[...], cql}`

- `/api/release/content?id=<confluenceId>`
  - Executa `twg confluence content get <id> --format html --output json`
  - Obtém body, space, title, version history
  - Converte HTML → texto limpo
  - Aplica template:
    ```
    # <Sistema> <versão>
    # Nota de Release — v<versão>
    **Data de publicação:** <lastModified>
    ## 1. Correções realizadas
    | Ticket | Descrição |
    ...
    ```
  - Se página já estiver em Markdown, preserva e normaliza cabeçalhos
  - Retorna `{success:true, markdown, html, meta:{space,title,url,lastModified}}`

Execução TWG:
- Binário: `/opt/twg/bin/twg`
- HOME: `/home/app`
- PATH inclui `/opt/twg/bin`
- Timeout 15s, fallback mensagem se TWG indisponível

### Frontend
**public/index.html**
- Modal #releaseNotesBackdrop:
  - Remove select produto PI/P3 fixo
  - Campos: Termo/Versão, Módulo opcional, Espaço opcional
  - Botão Buscar → `/api/release/search`
  - Lista resultados com title, space, versão extraída, link Confluence
- Ao clicar item → abre preview modal com conteúdo renderizado via `/api/release/content`
- Botão Exportar .md → gera Blob e download com nome `<Sistema>_v<versão>.md`

Compatibilidade:
- `withSafeJson` e Accept:application/json mantidos
- Erros retornam JSON via error handler global

## Dados
- Nenhuma tabela nova no MVP
- Respostas transitam em memória

## Tratamento de erros
- TWG indisponível → retornar output explicativo e link de busca Confluence
- Página não encontrada → 404 JSON
- Falha de parsing → retornar conteúdo bruto

## Testes
- Busca retorna páginas com título Nota de Release em múltiplos espaços
- Content retorna markdown no padrão GER
- Export gera arquivo com nome correto e conteúdo legível

## Critérios de aceite
1. Busca sem espaço fixo encontra Notas de Release em PI1, P3, GER etc
2. Preview exibe conteúdo da página Confluence
3. Export .md segue estrutura do arquivo GER 1.9.3.md
4. UI funciona sem quebrar fluxo atual de chamados

## Limitações MVP
- Sem cache local
- Sem geração PDF/DOCX
- Sem detecção automática de sistema se título não seguir padrão

## Próximos passos
- Indexação SQLite para histórico
- Export PDF com logo AZ
- Detecção de sistema via espaços ou labels
