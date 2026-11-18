#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Sobe o container (se nao estiver rodando)
docker compose up -d

# Aguarda health (max 30s)
echo "Aguardando health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
    echo "Health OK!"
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "ERRO: Health check falhou após 30s"
    docker compose logs --tail 20
    exit 1
  fi
done

# Sobe o tunel ngrok em background (se nao estiver rodando)
if ! pgrep -f "ngrok http" >/dev/null 2>&1; then
  nohup ngrok http 3000 --log-file=/tmp/ngrok-jira.log > /dev/null 2>&1 &
  sleep 4
fi

echo "Tunnel URL:"
TUNNEL_URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1 | sed 's/.*:"//;s/"$//')
if [ -z "$TUNNEL_URL" ]; then
  echo "ERRO: Nao foi possivel obter URL do ngrok"
  cat /tmp/ngrok-jira.log 2>/dev/null | tail -10
  exit 1
fi
echo "$TUNNEL_URL"
echo
echo "Use o header 'ngrok-skip-browser-warning: true' nas chamadas de API."
echo "Exemplo: curl -H 'ngrok-skip-browser-warning: true' $TUNNEL_URL/api/health"