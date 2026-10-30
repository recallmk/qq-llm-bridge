$patch = Join-Path $PSScriptRoot 'qq.'
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -like '*--profile sdk*' -and $_.CommandLine.Replace('/', '\').Contains($patch) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
