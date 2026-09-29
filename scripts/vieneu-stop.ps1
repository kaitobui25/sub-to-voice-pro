$ErrorActionPreference = "Stop"

$connections = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
  Write-Output "VieNeu-TTS is not listening on port 8000."
  exit 0
}

$stopped = 0
foreach ($processId in ($connections.OwningProcess | Sort-Object -Unique)) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -match "apps\.openai_speech") {
    Stop-Process -Id $processId -Force
    $stopped += 1
  }
}

if ($stopped -eq 0) {
  throw "Port 8000 is in use, but the listener does not look like VieNeu-TTS."
}
Write-Output "Stopped VieNeu-TTS."
