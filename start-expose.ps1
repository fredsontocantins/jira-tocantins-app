# Equivalente Windows de start-expose.sh
# Sobe o container, espera o health check e abre um tunel ngrok.
# Uso: powershell -ExecutionPolicy Bypass -File .\start-expose.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$Porta = 3000
$LogNgrok = Join-Path $PSScriptRoot "ngrok-jira.log"

# Sobe o container (se nao estiver rodando)
docker compose up -d

# Aguarda health
$healthOk = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $resposta = Invoke-WebRequest -Uri "http://localhost:$Porta/api/health" -UseBasicParsing -TimeoutSec 2
    if ($resposta.StatusCode -eq 200) { $healthOk = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $healthOk) {
  Write-Warning "A API nao respondeu o health check em 30s. Veja: docker compose logs -f"
}

# Sobe o tunel ngrok em background
if (-not (Get-Process -Name "ngrok" -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command "ngrok" -ErrorAction SilentlyContinue)) {
    Write-Error "ngrok nao esta instalado. Instale com: winget install ngrok"
  }
  Start-Process -FilePath "ngrok" `
    -ArgumentList @("http", "$Porta", "--log=stdout") `
    -RedirectStandardOutput $LogNgrok `
    -RedirectStandardError "$LogNgrok.err" `
    -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

# URL publica do tunel
Write-Output "Tunnel URL:"
try {
  $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
  $public = ($tunnels.tunnels | Where-Object { $_.public_url } | Select-Object -First 1).public_url
  Write-Output $public
} catch {
  Write-Warning "Nao foi possivel ler a API do ngrok (127.0.0.1:4040). Logs em: $LogNgrok"
}
Write-Output ""
Write-Output "Use o header 'ngrok-skip-browser-warning: true' nas chamadas de API."
