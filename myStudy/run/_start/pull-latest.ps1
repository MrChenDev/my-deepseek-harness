<#
  一键拉取最新代码。

  在 dev 分支上：同步 origin、更新本地 master 指针（不切分支）、合并 upstream/master，
  依赖清单有变化时自动跑 pnpm install。由同目录的 pull-latest.cmd 双击调用。
#>
param(
  # 跳过合并完成后的自动 push。
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $repoRoot
Write-Host "仓库: $repoRoot" -ForegroundColor Cyan

function Invoke-Git([string[]]$GitArguments) {
  & git @GitArguments
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArguments -join ' ') 失败（退出码 $LASTEXITCODE）" }
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'dev') {
  Write-Host "当前在 $branch 分支，先切到 dev…" -ForegroundColor Yellow
  Invoke-Git @('switch', 'dev')
}

$status = @(& git status --porcelain)
$tracked = @($status | Where-Object { $_ -notmatch '^\?\?' })
$untracked = @($status | Where-Object { $_ -match '^\?\?' })
if ($tracked.Count -gt 0) {
  Write-Host '有未提交的改动，先处理再拉取：' -ForegroundColor Red
  $tracked | ForEach-Object { Write-Host "  $_" }
  Write-Host '处理方式：git add <文件> 后 git commit；或 git stash -u 暂存。' -ForegroundColor Red
  exit 1
}
if ($untracked.Count -gt 0) {
  Write-Host "有 $($untracked.Count) 个未跟踪文件，不影响拉取，继续。" -ForegroundColor DarkGray
}

$before = (& git rev-parse HEAD).Trim()
$lockBefore = if (Test-Path 'pnpm-lock.yaml') { (Get-FileHash 'pnpm-lock.yaml').Hash } else { '' }

Write-Host '[1/4] 拉取 origin…' -ForegroundColor Cyan
Invoke-Git @('fetch', 'origin', '--prune')

Write-Host '[2/4] 更新本地 master 指针（不切分支）…' -ForegroundColor Cyan
& git fetch origin master:master
if ($LASTEXITCODE -ne 0) { Write-Host '  master 不是快进更新，已跳过；需要时手动处理。' -ForegroundColor Yellow }

Write-Host '[3/4] 把 dev 快进到 origin/dev…' -ForegroundColor Cyan
& git merge --ff-only origin/dev
if ($LASTEXITCODE -ne 0) { Write-Host '  本地 dev 与 origin/dev 已分叉（通常是本机有未推送提交），跳过。' -ForegroundColor Yellow }

Write-Host '[4/4] 合并上游 upstream/master…' -ForegroundColor Cyan
$upstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
$existingUpstream = (& git remote get-url upstream 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($existingUpstream)) {
  Write-Host "  未配置 upstream 远程，自动添加：$upstreamUrl" -ForegroundColor Yellow
  Invoke-Git @('remote', 'add', 'upstream', $upstreamUrl)
} else {
  Write-Host "  upstream -> $($existingUpstream.Trim())" -ForegroundColor DarkGray
}
Invoke-Git @('fetch', 'upstream', '--prune')
& git merge upstream/master --no-edit
if ($LASTEXITCODE -ne 0) {
  Write-Host '合并未完成（可能有冲突）。解决后执行：git add <文件> 然后 git commit' -ForegroundColor Red
  Write-Host '放弃本次合并：git merge --abort' -ForegroundColor Red
  exit 1
}

$after = (& git rev-parse HEAD).Trim()
$lockAfter = if (Test-Path 'pnpm-lock.yaml') { (Get-FileHash 'pnpm-lock.yaml').Hash } else { '' }
if ($lockAfter -ne $lockBefore) {
  Write-Host '依赖清单有变化，执行 pnpm install…' -ForegroundColor Cyan
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Write-Host 'pnpm install 失败，请看上面的输出。' -ForegroundColor Red; exit 1 }
} else {
  Write-Host '依赖清单未变化，跳过 pnpm install。' -ForegroundColor DarkGray
}

$aheadCount = [int]((& git rev-list --count 'origin/dev..HEAD').Trim())
if ($NoPush) {
  Write-Host '已按 -NoPush 跳过 push。' -ForegroundColor DarkGray
} elseif ($aheadCount -gt 0) {
  Write-Host "把 dev 推送到 origin（$aheadCount 个提交）…" -ForegroundColor Cyan
  & git push origin dev
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  push 失败：本地合并已完成，稍后可手动执行 git push origin dev。' -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host 'dev 没有未推送的提交，跳过 push。' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
if ($before -eq $after) { Write-Host '  代码本来就是最新的。' } else { Write-Host "  HEAD: $($before.Substring(0, 8)) -> $($after.Substring(0, 8))" }
Write-Host "  当前分支: $(($branch = & git rev-parse --abbrev-ref HEAD) | Out-Null; $branch)"
Write-Host '  下一步：pnpm start（菜单选 1=Web / 2=桌面端）'

Write-Host ''
Write-Host '本地分支与 GitHub fork 的对照：' -ForegroundColor Cyan
foreach ($name in @('dev', 'master')) {
  $local = (& git rev-parse --verify --quiet "refs/heads/$name")
  $remote = (& git rev-parse --verify --quiet "refs/remotes/origin/$name")
  if (-not $local) { Write-Host "  $name : 本地没有这个分支"; continue }
  if (-not $remote) { Write-Host "  $name : 远端 origin/$name 不存在"; continue }
  $parts = ((& git rev-list --left-right --count "$local...$remote") -split '\s+') | Where-Object { $_ -ne '' }
  $ahead = [int]$parts[0]
  $behind = [int]$parts[1]
  $state =
    if ($ahead -eq 0 -and $behind -eq 0) { '与远端一致' }
    elseif ($ahead -gt 0 -and $behind -eq 0) { "领先远端 $ahead 个提交（未推送）" }
    elseif ($ahead -eq 0 -and $behind -gt 0) { "落后远端 $behind 个提交" }
    else { "分叉（领先 $ahead / 落后 $behind）" }
  $colour = if ($ahead -eq 0 -and $behind -eq 0) { 'Green' } else { 'Yellow' }
  Write-Host ("  {0,-7} {1}  [{2}]" -f $name, $state, $local.Substring(0, 8)) -ForegroundColor $colour
}
Write-Host '  说明：master 是上游镜像，第 [2/4] 步只更新它的本地指针（不切分支、不动工作区）；日常只在 dev 上工作。' -ForegroundColor DarkGray
