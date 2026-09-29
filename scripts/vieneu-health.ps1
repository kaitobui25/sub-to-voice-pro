$ErrorActionPreference = "Stop"

$health = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 5
$voices = Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/voices" -TimeoutSec 5

[PSCustomObject]@{
  status = $health.status
  backend = $health.backend
  max_streams = $health.max_streams
  active = $health.active
  waiting = $health.waiting
  sample_rate = $health.sample_rate
  voices = $voices.data.Count
} | Format-List
