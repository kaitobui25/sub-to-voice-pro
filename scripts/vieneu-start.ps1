$ErrorActionPreference = "Stop"

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\tools\VieNeu-TTS"))
$artifactDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\artifacts"))
$stdout = Join-Path $artifactDir "vieneu-server.out.log"
$stderr = Join-Path $artifactDir "vieneu-server.err.log"

if (-not (Test-Path -LiteralPath (Join-Path $repo ".venv"))) {
  throw "VieNeu-TTS is not installed at $repo. Clone the official repo there and run: uv sync"
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 2
  if ($health.status -eq "ok") {
    Write-Output "VieNeu-TTS is already running on http://127.0.0.1:8000."
    exit 0
  }
} catch {
  # Nothing healthy is listening yet.
}

$occupied = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
  throw "Port 8000 is already in use by another process."
}

New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$env:VIENEU_BACKEND = "onnx"
$env:VIENEU_DEVICE = "cpu"
$env:VIENEU_MAX_STREAMS = "1"
$env:HOST = "127.0.0.1"
$env:PORT = "8000"

& (Join-Path $repo ".venv\Scripts\python.exe") (Join-Path $PSScriptRoot "vieneu-enable-complete-audio.py")
if ($LASTEXITCODE -ne 0) { throw "Could not enable VieNeu complete audio responses." }

$uv = Get-Command "uv" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $uv) {
  $userUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
  if (Test-Path -LiteralPath $userUv) { $uv = $userUv }
}
if (-not $uv) {
  throw "uv.exe was not found. Install uv or add it to PATH."
}

$process = Start-Process -FilePath $uv -ArgumentList @("run", "python", "-m", "apps.openai_speech") -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $artifactDir "vieneu-server.pid")
Write-Output "VieNeu-TTS starting on http://127.0.0.1:8000 (launcher PID $($process.Id))."
Write-Output "Check readiness with: npm run vieneu:health"

