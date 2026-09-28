<#
  为 DSH 的 desktop / web profile 安装（或升级）dshmarket 插件市场。

  逐个 profile 做三件事：
    1) 在 pnpm-workspace.yaml 里补 allowBuilds（git 版需要执行构建脚本）与
       minimumReleaseAgeExclude（放行刚发布的新版本）；
    2) 在该 profile 目录执行 pnpm add dshmarket（缺则安装，有则升级到最新）；
    3) 打印两个 profile 里实际生效的版本。

  幂等：重复运行只会补齐缺失的白名单项，不会重复写入。由同目录的
  install-dshmarket.cmd 双击调用。
#>
param()

# pnpm writes warnings and progress to stderr; 'Stop' turns those into
# terminating NativeCommandErrors on Windows PowerShell. Exit codes are
# checked explicitly instead.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
$packageName = 'dshmarket'
$gitUrl = 'https://github.com/dsh-market/dsh-market.git'

$allowBuildEntries = @(
  "  ${packageName}: true"
  "  '${packageName}@${gitUrl}': true"
)

function Add-YamlBlockEntries {
  param(
    [string[]]$Lines,
    [string]$Key,
    [string[]]$Entries
  )
  $result = New-Object System.Collections.Generic.List[string]
  $found = $false
  $index = 0
  while ($index -lt $Lines.Count) {
    $line = $Lines[$index]
    if ($line -match "^$([regex]::Escape($Key))\s*:") {
      $found = $true
      $result.Add($line)
      $index++
      while ($index -lt $Lines.Count -and ($Lines[$index] -match '^\s' -or $Lines[$index].Trim() -eq '')) {
        if ($Lines[$index] -notlike "*$packageName*") { $result.Add($Lines[$index]) }
        $index++
      }
      foreach ($entry in $Entries) { $result.Add($entry) }
      continue
    }
    $result.Add($line)
    $index++
  }
  if (-not $found) {
    $result.Add('')
    $result.Add("${Key}:")
    foreach ($entry in $Entries) { $result.Add($entry) }
  }
  return $result.ToArray()
}

function Update-ProfileWorkspace {
  param(
    [string]$ProfileDirectory,
    [string]$LatestVersion
  )
  $workspaceFile = Join-Path $ProfileDirectory 'pnpm-workspace.yaml'
  $lines = if (Test-Path $workspaceFile) { Get-Content -LiteralPath $workspaceFile -Encoding UTF8 } else { @('packages:', '  - .') }
  $entries = @($allowBuildEntries)
  # A git-sourced copy needs the exact tarball URL pnpm resolved; keep that
  # allowance in step with the lockfile so an older entry cannot go stale.
  $lockFile = Join-Path $ProfileDirectory 'pnpm-lock.yaml'
  if (Test-Path $lockFile) {
    $match = Select-String -LiteralPath $lockFile -Pattern 'https://codeload\.github\.com/[^"''\s]*' | Select-Object -First 1
    if ($match) { $entries += "  '${packageName}@$($match.Matches[0].Value)': true" }
  }
  $lines = Add-YamlBlockEntries -Lines $lines -Key 'allowBuilds' -Entries $entries
  $lines = Add-YamlBlockEntries -Lines $lines -Key 'minimumReleaseAgeExclude' -Entries @("  - ${packageName}@${LatestVersion}")
  Set-Content -LiteralPath $workspaceFile -Value $lines -Encoding UTF8
}

function Get-LatestVersion {
  $output = & pnpm view $packageName version 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  无法查询 ${packageName} 的最新版本：" -ForegroundColor Red
    $output | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    exit 1
  }
  return ($output | Select-Object -Last 1).ToString().Trim()
}

Write-Host "DSH profile 根目录: $profilesRoot" -ForegroundColor Cyan
$latest = Get-LatestVersion
Write-Host "$packageName 最新版本: $latest" -ForegroundColor Cyan

$installed = @{}
foreach ($name in @('desktop', 'web')) {
  $directory = Join-Path $profilesRoot $name
  Write-Host ''
  Write-Host "[$name] $directory" -ForegroundColor Cyan
  if (-not (Test-Path $directory)) {
    Write-Host '  该 profile 不存在，跳过。' -ForegroundColor DarkGray
    continue
  }
  Update-ProfileWorkspace -ProfileDirectory $directory -LatestVersion $latest
  Write-Host '  已补齐 pnpm-workspace.yaml 的白名单。' -ForegroundColor DarkGray
  Push-Location $directory
  try {
    # A git-sourced copy needs its build scripts reviewed and reruns prepare on
    # every install; the registry release is the same version without that step.
    $manifestPath = Join-Path $directory 'package.json'
    $spec = $null
    if (Test-Path $manifestPath) {
      $dependencies = (Get-Content -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json).dependencies
      if ($dependencies -and $dependencies.PSObject.Properties.Name -contains $packageName) {
        $spec = $dependencies.$packageName
      }
    }
    if ($spec -and ($spec -like 'github:*' -or $spec -like 'git:*' -or $spec -like 'http*')) {
      Write-Host "  当前是 git 依赖（$spec），先移除再装 npm 版。" -ForegroundColor Yellow
      & pnpm remove $packageName
    }
    # Name the registry version explicitly: it keeps the profile on the published
    # package instead of a git checkout that requires running build scripts.
    & pnpm add "${packageName}@${latest}"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  安装失败（退出码 $LASTEXITCODE）。" -ForegroundColor Red
      exit 1
    }
  } finally {
    Pop-Location
  }
  $manifest = Join-Path $directory "node_modules\$packageName\package.json"
  if (Test-Path $manifest) {
    $installed[$name] = (Get-Content -LiteralPath $manifest -Encoding UTF8 | ConvertFrom-Json).version
  }
}

Write-Host ''
Write-Host '完成。当前各 profile 版本：' -ForegroundColor Green
foreach ($name in @('desktop', 'web')) {
  $version = if ($installed.ContainsKey($name)) { $installed[$name] } else { '未安装' }
  Write-Host ("  {0,-8} {1}" -f $name, $version)
}
Write-Host '  下一步：重启桌面端/Web 端，在插件页启用该插件。' -ForegroundColor DarkGray
