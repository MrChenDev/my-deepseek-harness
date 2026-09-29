<#
  dsh 升级后一键把两个 profile 的插件升到最新，并检查兼容性。

  每个 profile 做三件事：
    1) 记录升级前的插件版本；
    2) pnpm update --latest 升级该 profile 的全部依赖；
    3) 打印升级前后对照，并对声明了 @deepseek-ai/dsh-* peer 的插件检查是否
       覆盖当前 dsh 版本；不覆盖时直接给出可复制的 allow-version 命令。

  幂等：已经是最新时只打印“未变化”。由同目录的 upgrade-plugins.cmd 双击调用。
#>
param()

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtimeVersion = (Get-Content (Join-Path $repositoryRoot 'package.json') -Encoding UTF8 | ConvertFrom-Json).version

function Get-ProfileDependencies {
  param([string]$Directory)
  $manifest = Join-Path $Directory 'package.json'
  if (-not (Test-Path $manifest)) { return @{} }
  $dependencies = (Get-Content -LiteralPath $manifest -Encoding UTF8 | ConvertFrom-Json).dependencies
  $result = @{}
  if ($dependencies) {
    foreach ($property in $dependencies.PSObject.Properties) { $result[$property.Name] = $property.Value }
  }
  return $result
}

function Get-InstalledVersion {
  param([string]$Directory, [string]$Package)
  $manifest = Join-Path $Directory "node_modules\$Package\package.json"
  if (-not (Test-Path $manifest)) { return $null }
  return (Get-Content -LiteralPath $manifest -Encoding UTF8 | ConvertFrom-Json).version
}

# 判断 peer 版本区间是否覆盖当前 dsh 版本（文本匹配，保守判断）。
function Test-PeerCoverage {
  param([string]$Range, [string]$Version)
  if ([string]::IsNullOrWhiteSpace($Range)) { return $true }
  if ($Range -match [regex]::Escape($Version)) { return $true }
  $parts = $Version -split '\.'
  if ($parts.Count -ge 2) {
    $prefix = "$($parts[0])\.$($parts[1])\."
    if ($Range -match "(?:\^|~|>=)\s*$prefix") { return $true }
  }
  return $false
}

# 插件声明的 dsh 相关 peer 区间，未声明时返回空表。
function Get-DshPeers {
  param([string]$Directory, [string]$Package)
  $manifest = Join-Path $Directory "node_modules\$Package\package.json"
  if (-not (Test-Path $manifest)) { return @{} }
  $peers = (Get-Content -LiteralPath $manifest -Encoding UTF8 | ConvertFrom-Json).peerDependencies
  $result = @{}
  if ($peers) {
    foreach ($property in $peers.PSObject.Properties) {
      if ($property.Name -like '@deepseek-ai/dsh-*') { $result[$property.Name] = $property.Value }
    }
  }
  return $result
}

Write-Host "当前 dsh 运行时版本: $runtimeVersion" -ForegroundColor Cyan
Write-Host "profile 根目录: $profilesRoot" -ForegroundColor Cyan

$exemptions = @{}
foreach ($profileName in @('desktop', 'web')) {
  $directory = Join-Path $profilesRoot $profileName
  Write-Host ''
  Write-Host "[$profileName] $directory" -ForegroundColor Cyan
  if (-not (Test-Path $directory)) {
    Write-Host '  该 profile 不存在，跳过。' -ForegroundColor DarkGray
    continue
  }

  $dependencies = Get-ProfileDependencies -Directory $directory
  if ($dependencies.Count -eq 0) {
    Write-Host '  没有安装任何插件，跳过。' -ForegroundColor DarkGray
    continue
  }

  $before = @{}
  foreach ($package in $dependencies.Keys) { $before[$package] = Get-InstalledVersion -Directory $directory -Package $package }

  Push-Location $directory
  try {
    Write-Host '  升级中（pnpm update --latest）…' -ForegroundColor DarkGray
    & pnpm update --latest 2>&1 | Select-Object -Last 4 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  } finally {
    Pop-Location
  }

  Write-Host '  插件版本：' -ForegroundColor Cyan
  foreach ($package in ($dependencies.Keys | Sort-Object)) {
    $after = Get-InstalledVersion -Directory $directory -Package $package
    $old = if ($before[$package]) { $before[$package] } else { '未安装' }
    $new = if ($after) { $after } else { '未安装' }
    $colour = if ($old -eq $new) { 'Gray' } else { 'Green' }
    Write-Host ("    {0,-28} {1} -> {2}" -f $package, $old, $new) -ForegroundColor $colour

    $peers = Get-DshPeers -Directory $directory -Package $package
    $unsatisfied = @()
    foreach ($peer in $peers.Keys) {
      if (-not (Test-PeerCoverage -Range $peers[$peer] -Version $runtimeVersion)) {
        $unsatisfied += ("{0}（要求 {1}）" -f $peer, $peers[$peer])
      }
    }
    if ($unsatisfied.Count -gt 0) {
      Write-Host ("      不兼容的 peer：" + ($unsatisfied -join '、')) -ForegroundColor Yellow
      if ($after) { $exemptions["$profileName|$package@$after"] = [pscustomobject]@{ Profile = $profileName; Package = $package; Version = $after } }
    }
  }
}

if ($exemptions.Count -gt 0) {
  Write-Host ''
  Write-Host '以下插件升级后仍未覆盖当前 dsh 版本（作者可能还没适配）：' -ForegroundColor Yellow
  foreach ($item in $exemptions.Values) {
    Write-Host ("  {0}@{1}（{2}）" -f $item.Package, $item.Version, $item.Profile) -ForegroundColor Yellow
  }
  Write-Host '如确认要继续用（接受“可能崩溃或数据丢失”的风险），可复制下面的命令放行：' -ForegroundColor Yellow
  foreach ($item in $exemptions.Values) {
    Write-Host ("  pnpm dsh plugin --profile {0} allow-version {1}@{2} --dsh-version {3} --accept-risk" -f `
      $item.Profile, $item.Package, $item.Version, $runtimeVersion) -ForegroundColor Cyan
  }
  Write-Host '查看或撤销豁免：pnpm dsh plugin --profile <desktop|web> version-exemptions / revoke-version …' -ForegroundColor DarkGray
} else {
  Write-Host ''
  Write-Host '所有插件的 peer 声明都覆盖当前 dsh 版本。' -ForegroundColor Green
}

Write-Host ''
Write-Host '下一步：重启桌面端 / 重启 Web（pnpm dsh web）。' -ForegroundColor Cyan
