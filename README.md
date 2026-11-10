# jira-tocantins-app

Aplicativo + API para buscar os **chamados abertos** do projeto TO (Tocantins) no Jira
(filtro salvo "Abertos", ID 11083) e expor os dados para outros sistemas consumirem.

## Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/chamados/abertos` | Lista os chamados abertos (cache 60s). Use `?refresh=true` para forçar |
| GET | `/api/filter/:id` | Retorna um filtro salvo do Jira |
| GET | `/api/jql?jql=...&limit=...&fields=...` | Consulta JQL arbitrária (integração flexível) |

Exemplo de consumo por outro sistema:
```bash
curl http://localhost:3000/api/chamados/abertos
```

Resposta:
```json
{
  "success": true,
  "source": "jira",
  "filter": "11083",
  "project": "TO",
  "count": 25,
  "data": [ { "key": "TO-4525", "summary": "...", "status": "...", "priority": "...", "assignee": {...}, ... } ],
  "fetchedAt": "2026-10-19T..."
}
```

## Frontend

Acesse `http://localhost:3000/` para visualizar os chamados em uma tabela.

## Configuração

1. Copie `.env.example` para `.env` e preencha:
   - `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_TOKEN` (token de API do Jira)
   - `JIRA_PROJECT`, `JIRA_FILTER_ID`, `JIRA_FILTER_JQL`
   - `PORT` (padrão 3000)
2. Instale dependências: `npm install`
3. Rode: `npm start` (ou `npm run dev` para modo watch)

### Rodando local no Windows

O app roda nativamente no Windows (`npm start`), sem Docker. A busca de Notas de
Release usa o CLI do **TWG**, que precisa estar instalado e autenticado na máquina:

```powershell
twg --version   # deve imprimir a versao (ex.: 1.4.4)
```

Se o `twg` já estiver no `PATH`, nada mais é preciso. Se estiver em outro lugar,
aponte o executável no `.env`:

```
TWG_BIN=C:\Users\<usuario>\AppData\Local\Programs\twg\bin\twg.exe
```

No Windows a configuração do TWG (perfis de autenticação) fica em `%APPDATA%\twg`.
Sem o TWG instalado, apenas os endpoints de Notas de Release respondem
`502` — o restante do app continua funcionando.

Para expor o container com túnel ngrok no Windows, use `start-expose.ps1`
(equivalente Windows de `start-expose.sh`):

```powershell
powershell -ExecutionPolicy Bypass -File .\start-expose.ps1
```

## Docker

Build e execução:
```bash
docker compose up -d --build
```
A API ficará exposta em `http://<host>:3000` (porta configurável via `HOST_PORT` no `.env` ou ambiente).

- Health: `http://<host>:3000/api/health`
- Dados: `http://<host>:3000/api/chamados/abertos`
- Status do container: `docker compose ps` / `docker inspect jira-tocantins-api`
- Logs: `docker compose logs -f`

Para expor publicamente (internet), use um túnel (ngrok/cloudflared) ou reverse proxy (nginx/Caddy) apontando para a porta 3000. A API já tem CORS habilitado.

### Exemplo com ngrok
```bash
ngrok http 3000
```

## Integração com outros sistemas

A API é aberta (sem autenticação, uso interno). Para linkar a outro sistema:
- Aponte a URL base do serviço (ex.: `http://host:3000`) e consuma `/api/chamados/abertos`.
- CORS habilitado (`*`) para facilitar consumo via browser.
- Para JQL customizado, use `/api/jql?jql=<jql url-encoded>`.