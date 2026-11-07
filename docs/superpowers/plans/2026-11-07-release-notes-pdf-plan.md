# Plano de Implementação - Relatório PDF Notas de Release

## Tarefas

1. Atualizar src/server.js
   - Adicionar import pdf-lib
   - Criar função extractVersionFromTitle
   - Criar função parseReleaseContent(html)
   - Rota GET /api/release/report
     - Validar params
     - Chamar busca TWG via spawnSync
     - Agrupar por space.key
     - Ordenar por lastModified
     - Para cada item, buscar conteúdo via twg confluence content get
     - Gerar PDF Confluence

2. Geração PDF Confluence
   - Usar PDFDocument de pdf-lib
   - Paginacao simples
   - Cabecalho com nome espaço
   - Para cada nota: titulo, versao, data, tabela de correcoes extraida

3. Relatorio Jira
   - Extrair keys Jira do conteudo com regex /[A-Z]+-\d+/
   - Chamar Jira API com credenciais .env
   - Montar tabela resumo

4. Frontend
   - Atualizar public/index.html modal
   - Adicionar botao Gerar PDF
   - Chamar /api/release/report e fazer download

5. Testes
   - Testar busca com filtros
   - Validar PDF gerado
   - Commit
