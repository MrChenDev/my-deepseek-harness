<#
  清理系统 Path 里的畸形条目，使 MSYS(sh) → cmd 传递 PATH 时不再被破坏，
  从而让仓库的 pre-push 钩子能正常运行。

  安全约束：
    - 只删除下面列出的垃圾条目，不新增、不重排、不改写其它条目；
    - 删除前把系统 Path 的原始值（含类型）与还原脚本一起备份到
      %USERPROFILE%\.dsh\backups\；
    - 需要管理员权限（本身会请求提权），-DryRun 可先预览不动手。
#>
param(
  # 只打印将要删除的条目，不写注册表。
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$valueName = 'Path'

# 已确认无效的条目：孤立的引号、末尾多引号、两条被截断的碎片。
$brokenEntries = @(
  '"'
  '%JAVA_HOME%\jre\bin"'
  'ram Files\Java\jdk-1.8\bin'
  'ram Files\TortoiseGit\bin'
)

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $DryRun -and -not (Test-Administrator)) {
  Write-Host '需要管理员权限：请双击同目录的 fix-system-path.cmd（由它请求提权）。' -ForegroundColor Red
  exit 1
}

$item = Get-Item -LiteralPath $key
$raw = $item.GetValue($valueName, '', 'DoNotExpandEnvironmentNames')
$kind = $item.GetValueKind($valueName)
$entries = $raw -split ';'

$toRemove = @($entries | Where-Object { $brokenEntries -contains $_ -or $_ -match '"' })
$suspicious = @($entries | Where-Object {
  $_ -ne '' -and -not ($brokenEntries -contains $_) -and
  ($_ -match '"' -or $_ -notmatch '^(?:[A-Za-z]:\\|\\\\|%)')
})

Write-Host "系统 Path 共 $($entries.Count) 条，类型 $kind" -ForegroundColor Cyan
if ($toRemove.Count -eq 0) {
  Write-Host '没有发现需要删除的畸形条目（可能已经修好了）。' -ForegroundColor Green
  if ($suspicious.Count -gt 0) {
    Write-Host '仍有可疑条目（本次不动）：' -ForegroundColor Yellow
    $suspicious | ForEach-Object { Write-Host "  [$_]" -ForegroundColor DarkGray }
  }
  exit 0
}

Write-Host '将删除以下条目：' -ForegroundColor Cyan
$toRemove | ForEach-Object { Write-Host "  [$_]" -ForegroundColor Yellow }
if ($suspicious.Count -gt 0) {
  Write-Host '另有可疑条目（本次不动）：' -ForegroundColor DarkGray
  $suspicious | ForEach-Object { Write-Host "  [$_]" -ForegroundColor DarkGray }
}

if ($DryRun) {
  Write-Host '--DryRun：未修改注册表。' -ForegroundColor Green
  exit 0
}

$backupDirectory = Join-Path $env:USERPROFILE '.dsh\backups'
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $backupDirectory "system-path-$stamp.txt"
Set-Content -LiteralPath $backupFile -Value $raw -Encoding UTF8
$restoreFile = Join-Path $backupDirectory "system-path-$stamp-restore.ps1"
@(
  '# 还原系统 Path 到清理前的状态（需管理员权限）'
  "`$key = '$key'"
  "`$raw = Get-Content -LiteralPath '$backupFile' -Raw"
  "Set-ItemProperty -LiteralPath `$key -Name '$valueName' -Value `$raw.TrimEnd(`"`r`n`") -Type $kind"
  'Write-Host ''已还原，请重开终端。'''
) | Set-Content -LiteralPath $restoreFile -Encoding UTF8

$cleaned = ($entries | Where-Object { $brokenEntries -notcontains $_ }) -join ';'
if ($kind -eq 'ExpandString') {
  Set-ItemProperty -LiteralPath $key -Name $valueName -Value $cleaned -Type ExpandString
} else {
  Set-ItemProperty -LiteralPath $key -Name $valueName -Value $cleaned -Type String
}

$after = (Get-Item -LiteralPath $key).GetValue($valueName, '', 'DoNotExpandEnvironmentNames')
Write-Host ''
Write-Host "已删除 $($toRemove.Count) 条；剩余 $((($after -split ';')).Count) 条。" -ForegroundColor Green
Write-Host "备份：$backupFile" -ForegroundColor DarkGray
Write-Host "还原脚本：$restoreFile" -ForegroundColor DarkGray
Write-Host '请重开终端（或重启）后再运行 pull-latest.cmd 验证。' -ForegroundColor Cyan
