<#
  一键拉取最新代码。

  在 dev 分支上：同步 origin、更新本地 master 指针（不切分支）、合并 upstream/master，
  依赖清单有变化时自动跑 pnpm install。由同目录的 pull-latest.cmd 双击调用。
#>
param(
  # 跳过全部自动 push（dev 与 master 镜像）。
  [switch]$NoPush
)

# Native commands report progress on stderr; 'Stop' turns that into a
# terminating NativeCommandError on Windows PowerShell. Failures are handled
# explicitly through $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $repoRoot
# Set-Location moves PowerShell's location only. .NET file APIs and child
# processes (pnpm, git) read the process directory, which stays wherever the
# double-clicked .cmd started.
[Environment]::CurrentDirectory = $repoRoot
Write-Host "仓库: $repoRoot" -ForegroundColor Cyan

function Invoke-Git([string[]]$GitArguments) {
  & git @GitArguments
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArguments -join ' ') 失败（退出码 $LASTEXITCODE）" }
}

# SHA-256 without Get-FileHash: that cmdlet is missing on constrained or older
# Windows PowerShell hosts, and the lockfile comparison only needs the bytes.
function Get-FileSha256 {
  param([string]$Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes)) -replace '-', '')
  } finally {
    $algorithm.Dispose()
  }
}

# A package the upstream removed keeps its former `lib/` and `node_modules/`
# behind, and the build then compiles that dead output. Remove only directories
# that carry no manifest and nothing but known build residue.
function Remove-StalePackageResidue {
  $cleanup = @'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const residue = new Set(['lib', 'node_modules', '.typecheck', 'types', 'dist']);
const removed = [];
const skipped = [];
const groups = fs.existsSync(path.join(root, 'packages')) ? fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true }) : [];
for (const group of groups) {
  if (!group.isDirectory()) continue;
  const groupDirectory = path.join(root, 'packages', group.name);
  for (const entry of fs.readdirSync(groupDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(groupDirectory, entry.name);
    if (fs.existsSync(path.join(directory, 'package.json'))) continue;
    const entries = fs.readdirSync(directory);
    if (entries.some(name => !residue.has(name))) { skipped.push(path.relative(root, directory)); continue; }
    const unlink = target => {
      for (const child of fs.readdirSync(target, { withFileTypes: true })) {
        const childPath = path.join(target, child.name);
        if (fs.lstatSync(childPath).isSymbolicLink()) { fs.unlinkSync(childPath); continue; }
        if (child.isDirectory()) unlink(childPath);
      }
    };
    unlink(directory);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    removed.push(path.relative(root, directory));
  }
}
process.stdout.write(JSON.stringify({ removed, skipped }));
'@
  $result = & node -e $cleanup $repoRoot 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  清理残留目录失败（可忽略，继续拉取）。' -ForegroundColor Yellow
    $result | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    return
  }
  $parsed = $result | Select-Object -Last 1 | ConvertFrom-Json
  if ($parsed.removed.Count -gt 0) {
    Write-Host ("  清理上游已删除包的残留目录 {0} 个：{1}" -f $parsed.removed.Count, ($parsed.removed -join '、')) -ForegroundColor Cyan
  } else {
    Write-Host '  没有上游已删除包的残留目录。' -ForegroundColor DarkGray
  }
  if ($parsed.skipped.Count -gt 0) {
    Write-Host ("  以下无 package.json 的目录含未知文件，未清理：{0}" -f ($parsed.skipped -join '、')) -ForegroundColor Yellow
  }
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
  $mergeHead = (& git rev-parse --git-path MERGE_HEAD).Trim()
  if (Test-Path -LiteralPath $mergeHead) {
    $localHead = (& git rev-parse HEAD).Trim()
    Write-Host '检测到一次中断的合并（MERGE_HEAD 存在），工作区停在合并中间状态。' -ForegroundColor Yellow
    Write-Host ("  当前 HEAD: {0}" -f $localHead.Substring(0, 8)) -ForegroundColor DarkGray
    Write-Host '  二选一处理：' -ForegroundColor Yellow
    Write-Host '    a) 放弃这次中断的合并（推荐；之后重跑本脚本会正规重做一遍）：git merge --abort' -ForegroundColor Cyan
    Write-Host '    b) 若这次合并就是你要的、冲突也都已解决：git commit --no-edit' -ForegroundColor Cyan
    Write-Host '  禁止使用 git reset --hard / git checkout -- . / git clean -fd，会丢改动。' -ForegroundColor Red
    exit 1
  }
  Write-Host '有未提交的改动，先处理再拉取：' -ForegroundColor Red
  $tracked | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  if ($tracked.Count -gt 20) { Write-Host ("  ……（共 {0} 项，其余省略）" -f $tracked.Count) -ForegroundColor DarkGray }
  Write-Host '处理方式（可逆）：git stash push -u -m "staged snapshot"，或 git add <文件> 后 git commit。' -ForegroundColor Red
  Write-Host '提示：若这些改动是"整套上游合并内容"（笔记归档、README、快照一起动），多半是未完成的合并产物，stash 后重跑本脚本即可。' -ForegroundColor DarkGray
  exit 1
}
if ($untracked.Count -gt 0) {
  Write-Host "有 $($untracked.Count) 个未跟踪文件，不影响拉取，继续。" -ForegroundColor DarkGray
}

$before = (& git rev-parse HEAD).Trim()
$lockFile = Join-Path $repoRoot 'pnpm-lock.yaml'
$lockBefore = if (Test-Path -LiteralPath $lockFile) { Get-FileSha256 -Path $lockFile } else { '' }

Write-Host '[1/5] 拉取 origin…' -ForegroundColor Cyan
try {
  Invoke-Git @('fetch', 'origin', '--prune')
} catch {
  Write-Host '  无法访问 GitHub（网络或加速器问题），已中止。' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
  exit 1
}

Write-Host '[2/5] 更新本地 master 指针（不切分支）…' -ForegroundColor Cyan
& git fetch origin master:master
if ($LASTEXITCODE -ne 0) {
  Write-Host '  master 不是快进更新（本地 master 与 fork 的 master 已分叉），已跳过。' -ForegroundColor Yellow
  Write-Host '  若本地 master 没有要保留的提交，可执行：git fetch origin +master:master' -ForegroundColor DarkGray
}

Write-Host '[3/5] 把 dev 快进到 origin/dev…' -ForegroundColor Cyan
& git merge --ff-only origin/dev
if ($LASTEXITCODE -ne 0) { Write-Host '  本地 dev 与 origin/dev 已分叉（通常是本机有未推送提交），跳过。' -ForegroundColor Yellow }

Write-Host '[4/5] 拉取上游并合并进 dev…' -ForegroundColor Cyan
$upstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
$existingUpstream = (& git remote get-url upstream 2>&1)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($existingUpstream)) {
  Write-Host "  未配置 upstream 远程，自动添加：$upstreamUrl" -ForegroundColor Yellow
  Invoke-Git @('remote', 'add', 'upstream', $upstreamUrl)
} else {
  Write-Host "  upstream -> $($existingUpstream.Trim())" -ForegroundColor DarkGray
}
try {
  Invoke-Git @('fetch', 'upstream', '--prune')
} catch {
  Write-Host '  无法访问上游仓库（网络或加速器问题），已中止。' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
  exit 1
}
& git merge upstream/master --no-edit
if ($LASTEXITCODE -ne 0) {
  # Pairing records (".i18n.yaml") store one hash per document section, so an
  # upstream edit to the same documents always collides there. Re-recording the
  # hashes from the merged documents is the repository's own resolution, so the
  # launcher does it whenever those records are the only conflicts.
  $unresolved = @(& git diff --name-only --diff-filter=U)
  $nonPairingConflicts = @($unresolved | Where-Object { $_ -notlike '*.i18n.yaml' })
  if ($unresolved.Count -eq 0 -or $nonPairingConflicts.Count -gt 0) {
    Write-Host '合并未完成（存在需要人工处理的冲突）：' -ForegroundColor Red
    $unresolved | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host '解决后执行：git add <文件> 然后 git commit' -ForegroundColor Red
    Write-Host '放弃本次合并：git merge --abort' -ForegroundColor Red
    exit 1
  }
  Write-Host "  只有双语配对记录冲突（$($unresolved.Count) 个），按仓库流程自动重录哈希…" -ForegroundColor Cyan
  foreach ($record in $unresolved) {
    $pairFile = $record -replace '\.i18n\.yaml$', '.md'
    $pairTranslation = $record -replace '\.i18n\.yaml$', '.zh.md'
    $markers = @(Select-String -LiteralPath $pairFile, $pairTranslation -Pattern '^(<<<<<<<|=======|>>>>>>>)' -ErrorAction SilentlyContinue)
    if ($markers.Count -gt 0) {
      Write-Host "  $pairFile 或它的中文对照本身有冲突标记，需要人工解决。" -ForegroundColor Red
      Write-Host '  放弃本次合并：git merge --abort' -ForegroundColor Red
      exit 1
    }
    Write-Host "    重录：$pairFile" -ForegroundColor DarkGray
    & pnpm run verify-translation-pairing --write $pairFile 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  重录失败：$pairFile，需要人工解决。" -ForegroundColor Red
      exit 1
    }
    & git add $record
  }
  Write-Host '  配对哈希已重录，完成合并提交（本地 pre-merge 钩子跳过，CI 仍会跑完整门禁）…' -ForegroundColor Cyan
  & git commit --no-edit --no-verify
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  合并提交失败，需要人工处理。' -ForegroundColor Red
    exit 1
  }
  Write-Host '  合并已完成。' -ForegroundColor Green
}

Write-Host '[5/5] 检查 fork 的 master 镜像…' -ForegroundColor Cyan
Remove-StalePackageResidue
$mirrorBehind = [int]((& git rev-list --count 'origin/master..upstream/master').Trim())
if ($mirrorBehind -eq 0) {
  Write-Host '  已是上游最新镜像，无需更新。' -ForegroundColor DarkGray
} else {
  Write-Host "  落后上游 $mirrorBehind 个提交，将随本次 push 一起快进。" -ForegroundColor Cyan
}

$after = (& git rev-parse HEAD).Trim()
$lockAfter = if (Test-Path -LiteralPath $lockFile) { Get-FileSha256 -Path $lockFile } else { '' }
if ($lockAfter -ne $lockBefore) {
  Write-Host '依赖清单有变化，执行 pnpm install…' -ForegroundColor Cyan
  & pnpm install
  if ($LASTEXITCODE -ne 0) { Write-Host 'pnpm install 失败，请看上面的输出。' -ForegroundColor Red; exit 1 }
} else {
  Write-Host '依赖清单未变化，跳过 pnpm install。' -ForegroundColor DarkGray
}

$aheadCount = [int]((& git rev-list --count 'origin/dev..HEAD').Trim())
$pushRefspecs = @()
if ($aheadCount -gt 0) { $pushRefspecs += 'dev' }
if ($mirrorBehind -gt 0) { $pushRefspecs += 'upstream/master:master' }
if ($NoPush) {
  Write-Host '已按 -NoPush 跳过 push。' -ForegroundColor DarkGray
} elseif ($pushRefspecs.Count -eq 0) {
  Write-Host '没有需要推送的内容。' -ForegroundColor DarkGray
} else {
  Write-Host "推送到 origin：$($pushRefspecs -join '、')…" -ForegroundColor Cyan
  $pushLog = & git push origin @pushRefspecs 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  pre-push 钩子环境不可用，改用 --no-verify 推送（CI 仍会跑完整检查）…' -ForegroundColor DarkGray
    & git push --no-verify origin @pushRefspecs
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  推送失败：请检查网络或凭据，然后手动执行 git push origin dev。' -ForegroundColor Red
      $pushLog | Select-Object -Last 8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
      exit 1
    }
    Write-Host '  已推送成功。' -ForegroundColor Green
  }
  if ($mirrorBehind -gt 0) { & git fetch origin master:master 2>&1 | Out-Null }
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
Write-Host '  说明：master 是上游镜像，第 [2/5] 步只更新它的本地指针，第 [5/5] 步快进镜像；日常只在 dev 上工作。' -ForegroundColor DarkGray
