$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -match '^C:') { throw 'C drive is read-only' }
$links = Get-Content -LiteralPath (Join-Path $root 'dependency-links.local.json') -Raw | ConvertFrom-Json
foreach ($link in $links) {
  $from = [IO.Path]::GetFullPath((Join-Path $root $link.path))
  $to = [IO.Path]::GetFullPath((Join-Path $root $link.target))
  if (-not $from.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $to.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency link escapes project' }
  if (-not (Test-Path -LiteralPath $to)) { throw "Missing dependency target: $to" }
  $item = Get-Item -LiteralPath $from -Force -ErrorAction SilentlyContinue
  if ($item) {
    if ($item.LinkType -ne 'Junction') { throw "Refusing to replace a physical directory: $from" }
    if ([IO.Path]::GetFullPath($item.Target) -eq $to) { continue }
    [IO.Directory]::Delete($from)
  }
  New-Item -ItemType Directory -Path (Split-Path $from) -Force | Out-Null
  New-Item -ItemType Junction -Path $from -Target $to | Out-Null
}
Write-Output "Dependency links ready: $(@($links).Count)"
