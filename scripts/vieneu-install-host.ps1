param([string]$ExtensionId)
$ErrorActionPreference = "Stop"

if (-not $ExtensionId) {
  throw "Pass the extension ID shown at chrome://extensions: npm run vieneu:install-host -- <extension-id>"
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId must be the 32-character ID shown at chrome://extensions."
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$artifacts = Join-Path $root "artifacts"
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$exe = Join-Path $artifacts "vieneu-native-host.exe"
$source = Join-Path $PSScriptRoot "vieneu-native-host.cs"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "Windows .NET Framework C# compiler was not found."
}
& $compiler /nologo /target:exe "/out:$exe" /r:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) { throw "Native host compilation failed." }

$startScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "vieneu-start.ps1"))
Set-Content -LiteralPath (Join-Path $artifacts "vieneu-start-script.txt") -Value $startScript -NoNewline
$manifestPath = Join-Path $artifacts "vieneu-native-host.json"
$manifest = @{
  name = "com.sub_to_voice.vieneu"
  description = "Start local VieNeu TTS for Sub-to-Voice Pro"
  path = $exe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sub_to_voice.vieneu"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Output "VieNeu native host installed for extension $ExtensionId. Reload the extension at chrome://extensions."
