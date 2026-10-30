param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('screen','windows','focus','click','double-click','scroll','type','keys')]
  [string]$Action,
  [int]$X=0,
  [int]$Y=0,
  [int]$Delta=0,
  [int]$ProcessId=0,
  [ValidateSet('left','right')][string]$Button='left',
  [string]$Text='',
  [string]$Keys=''
)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('QqBridgeDesktop' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QqBridgeDesktop {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
}
'@
}
[void][QqBridgeDesktop]::SetProcessDPIAware()
$bounds=[Windows.Forms.SystemInformation]::VirtualScreen
function Assert-Point {
  if(-not $bounds.Contains($X,$Y)){throw '坐标超出当前屏幕；请先重新截图确定坐标'}
}
function Assert-Foreground {
  if([QqBridgeDesktop]::GetForegroundWindow() -eq [IntPtr]::Zero){throw '没有可操作的前台窗口'}
}
$result=@{ok=$true; action=$Action}
switch($Action){
  'windows' {
    $result.windows=@(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {
      @{processId=$_.Id; process=$_.ProcessName; title=$_.MainWindowTitle; foreground=($_.MainWindowHandle -eq [QqBridgeDesktop]::GetForegroundWindow())}
    })
  }
  'screen' {
    $cacheRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\work\.tmp\qq-desktop'))
    if($cacheRoot -match '^C:'){throw 'C 盘只读'}
    $ancestor=$cacheRoot
    while($ancestor){
      if(Test-Path -LiteralPath $ancestor){
        $item=Get-Item -LiteralPath $ancestor -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '截图路径包含链接'}
      }
      $parent=Split-Path -Parent $ancestor
      if($parent -eq $ancestor){break}; $ancestor=$parent
    }
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    # Bound only this helper's generated captures; never enumerate other user files for removal.
    foreach($old in @(Get-ChildItem -LiteralPath $cacheRoot -File | Where-Object {$_.Name -match '^screen-[a-f0-9]{32}\.png$' -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddHours(-1)})){
      if($old.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
      Remove-Item -LiteralPath $old.FullName
    }
    $file=Join-Path $cacheRoot ('screen-'+[guid]::NewGuid().ToString('N')+'.png')
    $bitmap=[Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
    try {
      $graphics=[Drawing.Graphics]::FromImage($bitmap)
      try {$graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size)} finally {$graphics.Dispose()}
      $bitmap.Save($file,[Drawing.Imaging.ImageFormat]::Png)
    } finally {$bitmap.Dispose()}
    $result.path=$file; $result.left=$bounds.Left; $result.top=$bounds.Top
    $result.width=$bounds.Width; $result.height=$bounds.Height
    $result.note='使用 read_image 读取这份截图；坐标使用原始屏幕像素，包含 left/top 偏移。'
  }
  'focus' {
    if($ProcessId -le 0){throw '请用 windows 列出的真实 processId'}
    $target=Get-Process -Id $ProcessId
    if($target.MainWindowHandle -eq 0){throw '进程没有可见窗口'}
    [void][QqBridgeDesktop]::ShowWindowAsync($target.MainWindowHandle,9)
    [void][QqBridgeDesktop]::SetForegroundWindow($target.MainWindowHandle)
    Start-Sleep -Milliseconds 200
    if([QqBridgeDesktop]::GetForegroundWindow() -ne $target.MainWindowHandle){throw '窗口未获得焦点；不要继续向其他窗口输入'}
    $result.processId=$ProcessId
  }
  {$_ -in 'click','double-click'} {
    Assert-Point
    if(-not [QqBridgeDesktop]::SetCursorPos($X,$Y)){throw '无法定位鼠标'}
    $down=if($Button -eq 'right'){[uint32]8}else{[uint32]2}
    $up=if($Button -eq 'right'){[uint32]16}else{[uint32]4}
    $count=if($Action -eq 'double-click'){2}else{1}
    for($i=0;$i -lt $count;$i++){
      [QqBridgeDesktop]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
      [QqBridgeDesktop]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
      if($count -eq 2 -and $i -eq 0){Start-Sleep -Milliseconds 80}
    }
    $result.x=$X; $result.y=$Y
  }
  'scroll' {
    Assert-Point
    if($Delta -eq 0 -or [Math]::Abs([long]$Delta) -gt 2400){throw 'Delta 应为 -2400 到 2400 间的非零值，通常用 120 的倍数'}
    if(-not [QqBridgeDesktop]::SetCursorPos($X,$Y)){throw '无法定位鼠标'}
    $wheel=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Delta),0)
    [QqBridgeDesktop]::mouse_event(0x800,0,0,$wheel,[UIntPtr]::Zero)
  }
  'type' {
    Assert-Foreground
    if($Text.Length -gt 4000){throw '一次最多输入 4000 个字符'}
    # Escape SendKeys syntax: literal text must not become shortcuts.
    $literal=$Text.Replace("`r`n","`n").Replace("`r","`n")
    $escaped=[regex]::Replace($literal,'[+^%~(){}\[\]]',{param($match) '{'+$match.Value+'}'})
    $escaped=$escaped.Replace("`n",'{ENTER}')
    [Windows.Forms.SendKeys]::SendWait($escaped)
    $result.characters=$Text.Length
  }
  'keys' {
    Assert-Foreground
    if(-not $Keys -or $Keys.Length -gt 200){throw 'Keys 长度应为 1 到 200；采用 Windows SendKeys 语法'}
    [Windows.Forms.SendKeys]::SendWait($Keys)
  }
}
$result | ConvertTo-Json -Depth 6 -Compress
