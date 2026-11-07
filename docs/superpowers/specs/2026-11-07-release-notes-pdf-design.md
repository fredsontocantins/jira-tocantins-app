# Nota de Release PDF - Design

## Objetivo
Gerar relatórios PDF a partir das Notas de Release do Confluence, agrupadas por espaço e ordenadas por data de publicação, com relatórios separados para Confluence e Jira.

## Contexto
Busca de Notas de Release já implementada via TWG:
- `/api/release/spaces` lista espaços Confluence
- `/api/release/search` CQL `type=page AND title ~ "Nota de Release"` com filtros term/module/space/dateFrom/dateTo
- `/api/release/content` retorna markdown do page

Credenciais Atlassian em `.env`: ATLAS_EMAIL, ATLAS_API_TOKEN

## Arquitetura

### Backend Node/Express
- `src/server.js`
  - Nova rota `GET /api/release/report`
    Query params: term, module, space, dateFrom, dateTo, format=confluence|jira|both
    1. Chama `/api/release/search` interno
    2. Agrupa resultados por `space.key`
    3. Ordena cada grupo por `lastModified` desc
    4. Para cada item, chama TWG confluence content get para obter HTML/markdown
    5. Extrai tabela de correções e keys Jira do conteúdo via regex
    6. Gera PDF com pdf-lib
    7. Retorna PDF em base64 + filename

### Geração PDF
- pdf-lib
- Um PDF único com seções por espaço
- Índice por espaço
- Para cada nota: título, versão extraída, data publicação, tabela de correções
- Relatório Jira separado: a partir das keys encontradas, consulta Jira REST `/rest/api/3/search?jql=key in (...)` e monta tabela com chave, resumo, status, URL

### Frontend
- Modal Nota de Release existente
- Botão "Gerar PDF"
- Campos já existentes: releaseTermInput, releaseModuleInput, releaseSpaceSelect, releaseDateFrom, releaseDateTo
- Ao clicar, chama `/api/release/report` com params e faz download

## Fluxo de dados
UI -> /api/release/report -> busca TWG -> parse conteúdo -> agrupar por espaço -> ordenar por data -> gerar PDF -> download

## Requisitos não funcionais
- Sem exposição de segredos .env
- Respostas em PT-BR
- Paths claros nos logs

## Próximos passos
- Implementar rota /api/release/report
- Implementar geração PDF Confluence
- Implementar enriquecimento Jira
- Atualizar UI com botão Gerar PDF
