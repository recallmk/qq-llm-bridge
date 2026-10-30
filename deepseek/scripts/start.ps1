param([switch]$Watchdog)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -match '^C:') { throw 'C drive is read-only' }
$bridge = Join-Path $root 'qq-bridge'
if (Test-Path -LiteralPath (Join-Path $bridge '.migration-in-progress')) { exit 0 }
$lock = Join-Path $bridge 'bridge.lock'
if (Test-Path -LiteralPath $lock) {
  $bridgePid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $lock -Raw).Trim(), [ref]$bridgePid)) {
    $proc = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -eq (Join-Path $root 'runtime\node\node.exe')) { Write-Output "Bridge already running: $bridgePid"; exit 0 }
  }
}
$env:TEMP = Join-Path $root '.tmp'
$env:TMP = $env:TEMP
$env:DSH_HOME = Join-Path $root '.dsh'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$node = Join-Path $root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Install Node 24 into runtime\node first; see README.md' }
& $node (Join-Path $PSScriptRoot 'configure.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Configuration failed' }
$cfg = Get-Content -LiteralPath (Join-Path $bridge 'config.json') -Raw | ConvertFrom-Json
function Test-Port([int]$port) {
  $client = [Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $port); return $task.Wait(500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}
$wsPort = ([uri]$cfg.onebotWs).Port
if (-not (Test-Port $wsPort)) {
  $launcher = Join-Path $root 'napcat\shell\launcher-user.bat'
  if (-not (Test-Path -LiteralPath $launcher)) { throw 'Install NapCat into napcat\shell first' }
  $startArgs = @{FilePath=$launcher; WindowStyle='Hidden'; WorkingDirectory=(Split-Path $launcher); RedirectStandardOutput=(Join-Path $bridge 'napcat-startup.log'); RedirectStandardError=(Join-Path $bridge 'napcat-startup.err.log')}
  if ($cfg.botQq) { $startArgs.ArgumentList = @('-q', [string]$cfg.botQq) }
  Start-Process @startArgs
  for ($i=0; $i -lt 30; $i++) { if (Test-Port $wsPort) { break }; Start-Sleep -Seconds 1 }
  if (-not (Test-Port $wsPort)) { Write-Warning 'NapCat not ready; inspect local NapCat logs / QR login' }
}
Start-Process -FilePath (Join-Path $bridge 'run-bridge.bat') -WorkingDirectory $bridge -WindowStyle Hidden
Write-Output "Started DS QQ project: $root"
