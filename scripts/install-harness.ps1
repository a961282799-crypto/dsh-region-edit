param(
  [string]$HarnessExe = ''
)
# 一键安装到本机 DeepSeek Harness：兼容检查 → 关闭 Harness（先询问）→ 安装当前版本 → 重新打开。
# 三个插件共用同一份脚本，插件名、版本和安装包都从本插件的 package.json 读取。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$info = @{
  'dsh-island'      = @{ Title = 'DeepSeek 灵动岛'; Hint = '灵动岛会出现在屏幕上。位置、大小和提醒方式在 Harness 的「设置 › 灵动岛」中调整。' }
  'dsh-timeband'    = @{ Title = 'DSH TimeBand';   Hint = '侧栏底部头像右侧会显示峰谷时段，点击查看今日时间轴。'; Replaces = @('@a961282799/dsh-timeband') }
  'dsh-region-edit' = @{ Title = '圈选修改';       Hint = '在文件预览里即可点选或圈选要修改的区域。' }
}[$pkg.name]
if (-not $info) { $info = @{ Title = $pkg.name; Hint = '' } }
$title = "$($info.Title) · 安装"
$want = $pkg.peerDependencies.'@deepseek-ai/dsh'
function Say([string]$message, [string]$icon = 'Information') { [System.Windows.MessageBox]::Show($message, $title, 'OK', $icon) | Out-Null }

# 找到 Harness：参数 > 正在运行的进程 > 常见安装位置。
function Find-HarnessExe {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($running) { return $running.Path }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    'D:\deepseek harness\DeepSeek Harness.exe',
    'D:\DeepSeek Harness\DeepSeek Harness.exe'
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return ''
}

try {
  if (-not $HarnessExe) { $HarnessExe = Find-HarnessExe }
  if (-not $HarnessExe -or -not (Test-Path -LiteralPath $HarnessExe)) { throw "找不到 DeepSeek Harness 的安装位置。`n请先打开一次 Harness 再双击安装。" }
  $harnessDir = Split-Path -Parent $HarnessExe
  $dsh = Join-Path $harnessDir 'resources\runtime\cli\bin\dsh.cmd'
  if (-not (Test-Path -LiteralPath $dsh)) { throw "找不到 Harness 随附的命令行工具：`n$dsh" }

  # 安装包：artifacts\<包名>-<版本>.tgz；没有就现场打包。
  $archiveName = $pkg.name.TrimStart('@').Replace('/', '-')
  $archive = Join-Path $root "artifacts\$archiveName-$($pkg.version).tgz"
  if (-not (Test-Path -LiteralPath $archive)) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "找不到安装包：$archive`n请安装 Node.js 后重试，或在 Harness 的「插件 › 添加插件」中输入 $($pkg.name) 安装。" }
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'artifacts') | Out-Null
    Push-Location $root
    $ErrorActionPreference = 'Continue'
    try {
      if ($pkg.scripts.'pack:plugin') { & npm run pack:plugin 2>&1 | Out-Null } else { & npm pack --pack-destination artifacts 2>&1 | Out-Null }
    } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
    if (-not (Test-Path -LiteralPath $archive)) { throw "打包失败，找不到：$archive" }
  }

  # Harness 随附的 dsh.cmd 报出它的版本号；@deepseek-ai/dsh 和所有 dsh-* 声明都必须与之一致，和 Harness 加载插件时的规则相同。
  $ErrorActionPreference = 'Continue'
  $verOut = (& $dsh --version 2>&1 | ForEach-Object { "$_" }) -join ' '
  $ErrorActionPreference = 'Stop'
  $hostVersion = ([regex]::Match($verOut, '\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?')).Value
  if (-not $hostVersion) { throw "读不到 Harness 的版本号，没有做任何改动。`n`n$verOut" }
  $unmet = @()
  if ($pkg.peerDependencies) { $unmet = @($pkg.peerDependencies.PSObject.Properties | Where-Object { ($_.Name -eq '@deepseek-ai/dsh' -or $_.Name -like '@deepseek-ai/dsh-*') -and $_.Value -ne $hostVersion }) }
  if ($unmet.Count) {
    throw "你的 Harness 是 $hostVersion，这个版本的 $($info.Title)（$($pkg.version)）适配的是 $want。`n`n请先把 Harness 升级到 $want 再安装。没有做任何改动。"
  }

  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    $answer = [System.Windows.MessageBox]::Show("安装前需要先关闭 DeepSeek Harness。`n现在关闭吗？正在进行的任务会被中断。", $title, 'YesNo', 'Question')
    if ($answer -ne 'Yes') { return }
    $running | Stop-Process -ErrorAction SilentlyContinue
    $running | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Harness 没能关闭，请从托盘右键退出后再试。' }
  }

  $log = Join-Path $root 'artifacts\install.log'
  $ErrorActionPreference = 'Continue'
  "== $(Get-Date -Format s) 安装 $($pkg.name) $($pkg.version) 到 Harness $hostVersion" | Out-File -LiteralPath $log -Encoding UTF8
  # 换过包名的旧版先移除，避免同一个插件加载两次（没装过时会报错，忽略即可）。
  foreach ($old in @($info.Replaces) | Where-Object { $_ }) {
    & $dsh plugin --profile desktop remove $old 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
  }
  # 原地升级，保留原来的设置；万一失败，再移除旧版重装一次。
  & $dsh plugin --profile desktop add $archive 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    "-- 直接升级失败，移除旧版后重装" | Out-File -LiteralPath $log -Append -Encoding UTF8
    & $dsh plugin --profile desktop remove $pkg.name 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
    & $dsh plugin --profile desktop add $archive 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
    $code = $LASTEXITCODE
  }
  $ErrorActionPreference = 'Stop'
  Start-Process -FilePath $HarnessExe
  if ($code -ne 0) {
    $tail = (Get-Content -LiteralPath $log -Tail 12 -Encoding UTF8) -join "`n"
    throw "安装失败（退出码 $code），Harness 已重新打开。`n`n$tail`n`n完整记录：$log"
  }
  Say "已安装 $($info.Title) $($pkg.version)。`nHarness 正在重新打开。`n`n$($info.Hint)"
} catch {
  Say $_.Exception.Message 'Error'
}
