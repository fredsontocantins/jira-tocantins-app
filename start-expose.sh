#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Sobe o container (se nao estiver rodando)
docker compose up -d

# Aguarda health
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health >/dev/null; then break; fi
  sleep 1
done

# Sobe o tunel ngrok em background
if ! pgrep -f "ngrok http" >/dev/null; then
  nohup ngrok http 3000 --log=stdout > /tmp/ngrok-jira.log 2>&1 &
  sleep 4
fi

echo "Tunnel URL:"
curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1 | sed 's/.*:"//;s/"$//'
echo
echo "Use o header 'ngrok-skip-browser-warning: true' nas chamadas de API."