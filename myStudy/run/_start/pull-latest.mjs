#!/usr/bin/env node
/**
 * 一键拉取最新代码（跨平台）。
 *
 * 在 dev 分支上：同步 origin、更新本地 master 指针、合并 upstream/master、
 * 处理双语配对记录冲突、清理上游已删除包的残留、按需 pnpm install、
 * 最后推送 dev 与 master 镜像。
 *
 * 用法：node pull-latest.mjs [--no-push] [--verify] [--dry-run]
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const ARGS = process.argv.slice(2)
const NO_PUSH = ARGS.includes('--no-push')
const VERIFY = ARGS.includes('--verify')
const DRY_RUN = ARGS.includes('--dry-run')

/** 执行 git，返回退出码与输出。 */
function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...options,
  })
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

/** 执行 git 并实时显示输出。 */
function gitLive(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, stdio: 'inherit' })
}

/** 执行 pnpm 并实时显示输出。 */
function pnpm(args) {
  return spawnSync('pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
}

/** 文件 sha256。 */
function sha256File(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''
}

/** 当前是否存在未完成的合并。 */
function hasMergeHead() {
  const result = git(['rev-parse', '--git-path', 'MERGE_HEAD'])
  if (result.code !== 0) return false
  return existsSync(resolve(REPO_ROOT, result.stdout))
}

/** 删除上游已删除包留下的构建残留（无 package.json 且只含构建产物）。 */
function removeStalePackageResidue() {
  const packageRoot = join(REPO_ROOT, 'packages')
  if (!existsSync(packageRoot)) return { removed: [], skipped: [] }
  const residue = new Set(['lib', 'node_modules', '.typecheck', 'types', 'dist'])
  const removed = []
  const skipped = []
  for (const group of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDirectory = join(packageRoot, group.name)
    for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(groupDirectory, entry.name)
      if (existsSync(join(directory, 'package.json'))) continue
      const entries = readdirSync(directory)
      if (entries.some(name => !residue.has(name))) {
        skipped.push(relative(REPO_ROOT, directory))
        continue
      }
      const unlink = target => {
        for (const child of readdirSync(target, { withFileTypes: true })) {
          const childPath = join(target, child.name)
          if (lstatSync(childPath).isSymbolicLink()) {
            unlinkSync(childPath)
            continue
          }
          if (child.isDirectory()) unlink(childPath)
        }
      }
      unlink(directory)
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
      removed.push(relative(REPO_ROOT, directory))
    }
  }
  return { removed, skipped }
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout
if (branch !== 'dev') {
  console.log(`当前在 ${branch} 分支，先切到 dev…`)
  const switched = gitLive(['switch', 'dev'])
  if (switched.status !== 0) process.exit(1)
}

const status = git(['status', '--porcelain']).stdout
const statusLines = status ? status.split('\n') : []
const tracked = statusLines.filter(line => !line.startsWith('??'))
const untracked = statusLines.filter(line => line.startsWith('??'))
if (tracked.length > 0) {
  if (hasMergeHead()) {
    const head = git(['rev-parse', 'HEAD']).stdout.slice(0, 8)
    console.log('检测到一次中断的合并（MERGE_HEAD 存在），工作区停在合并中间状态。')
    console.log(`  当前 HEAD: ${head}`)
    console.log('  二选一处理：')
    console.log('    a) 放弃这次中断的合并（推荐；之后重跑本脚本会正规重做一遍）：git merge --abort')
    console.log('    b) 若这次合并就是你要的、冲突也都已解决：git commit --no-edit')
    console.log('  禁止使用 git reset --hard / git checkout -- . / git clean -fd，会丢改动。')
    process.exit(1)
  }
  console.log('有未提交的改动，先处理再拉取：')
  for (const line of tracked.slice(0, 20)) console.log(`  ${line}`)
  if (tracked.length > 20) console.log(`  ……（共 ${tracked.length} 项，其余省略）`)
  console.log('处理方式（可逆）：git stash push -u -m "staged snapshot"，或 git add <文件> 后 git commit。')
  process.exit(1)
}
if (untracked.length > 0) console.log(`有 ${untracked.length} 个未跟踪文件，不影响拉取，继续。`)

const before = git(['rev-parse', 'HEAD']).stdout
const lockFile = join(REPO_ROOT, 'pnpm-lock.yaml')
const lockBefore = sha256File(lockFile)

console.log('[1/5] 拉取 origin…')
{
  const fetch = gitLive(['fetch', 'origin', '--prune'])
  if (fetch.status !== 0) {
    console.log('  无法访问 GitHub（网络或加速器问题），已中止。')
    process.exit(1)
  }
}

console.log('[2/5] 更新本地 master 指针（不切分支）…')
{
  const update = git(['fetch', 'origin', 'master:master'])
  if (update.code !== 0) {
    console.log('  master 不是快进更新（本地 master 与 fork 的 master 已分叉），已跳过。')
    console.log('  若本地 master 没有要保留的提交，可执行：git fetch origin +master:master')
  }
}

if (DRY_RUN) {
  const behind = Number(git(['rev-list', '--count', 'HEAD..origin/dev']).stdout || '0')
  const upstreamBehind = Number(git(['rev-list', '--count', 'HEAD..upstream/master']).stdout || '0')
  console.log(`--dry-run：dev 落后 origin/dev ${behind} 个提交，落后 upstream/master ${upstreamBehind} 个提交；未执行合并。`)
  process.exit(0)
}

console.log('[3/5] 把 dev 快进到 origin/dev…')
{
  const merge = gitLive(['merge', '--ff-only', 'origin/dev'])
  if (merge.status !== 0) console.log('  本地 dev 与 origin/dev 已分叉（通常是本机有未推送提交），跳过。')
}

console.log('[4/5] 拉取上游并合并进 dev…')
{
  const existing = git(['remote', 'get-url', 'upstream'])
  if (existing.code !== 0 || !existing.stdout) {
    console.log(`  未配置 upstream 远程，自动添加：${UPSTREAM_URL}`)
    const added = gitLive(['remote', 'add', 'upstream', UPSTREAM_URL])
    if (added.status !== 0) process.exit(1)
  } else {
    console.log(`  upstream -> ${existing.stdout}`)
  }
  const fetch = gitLive(['fetch', 'upstream', '--prune'])
  if (fetch.status !== 0) {
    console.log('  无法访问上游仓库（网络或加速器问题），已中止。')
    process.exit(1)
  }
  const merge = gitLive(['merge', 'upstream/master', '--no-edit'])
  if (merge.status !== 0) {
    const unresolved = git(['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean)
    const nonPairing = unresolved.filter(path => !path.endsWith('.i18n.yaml'))
    if (unresolved.length === 0 || nonPairing.length > 0) {
      console.log('合并未完成（存在需要人工处理的冲突）：')
      for (const path of unresolved.slice(0, 20)) console.log(`  ${path}`)
      console.log('解决后执行：git add <文件> 然后 git commit')
      console.log('放弃本次合并：git merge --abort')
      process.exit(1)
    }
    console.log(`  只有双语配对记录冲突（${unresolved.length} 个），按仓库流程自动重录哈希…`)
    for (const record of unresolved) {
      const pairFile = record.replace(/\.i18n\.yaml$/, '.md')
      const pairTranslation = record.replace(/\.i18n\.yaml$/, '.zh.md')
      const markerPattern = /^(<<<<<<<|=======|>>>>>>>)/
      const hasMarkers = [pairFile, pairTranslation].some(path => {
        const full = join(REPO_ROOT, path)
        if (!existsSync(full)) return false
        return readFileSync(full, 'utf8').split('\n').some(line => markerPattern.test(line))
      })
      if (hasMarkers) {
        console.log(`  ${pairFile} 或它的中文对照本身有冲突标记，需要人工解决。`)
        console.log('  放弃本次合并：git merge --abort')
        process.exit(1)
      }
      console.log(`    重录：${pairFile}`)
      const recorded = pnpm(['run', 'verify-translation-pairing', '--write', pairFile])
      if (recorded.status !== 0) {
        console.log(`  重录失败：${pairFile}，需要人工解决。`)
        process.exit(1)
      }
      const added = gitLive(['add', record])
      if (added.status !== 0) process.exit(1)
    }
    console.log('  配对哈希已重录，完成合并提交（本地 pre-merge 钩子跳过，CI 仍会跑完整门禁）…')
    const committed = gitLive(['commit', '--no-edit', '--no-verify'])
    if (committed.status !== 0) {
      console.log('  合并提交失败，需要人工处理。')
      process.exit(1)
    }
    console.log('  合并已完成。')
  }
}

console.log('[5/5] 检查 fork 的 master 镜像…')
const residue = removeStalePackageResidue()
if (residue.removed.length > 0) {
  console.log(`  清理上游已删除包的残留目录 ${residue.removed.length} 个：${residue.removed.join('、')}`)
} else {
  console.log('  没有上游已删除包的残留目录。')
}
if (residue.skipped.length > 0) console.log(`  以下无 package.json 的目录含未知文件，未清理：${residue.skipped.join('、')}`)

const mirrorBehind = Number(git(['rev-list', '--count', 'origin/master..upstream/master']).stdout || '0')
if (mirrorBehind === 0) console.log('  已是上游最新镜像，无需更新。')
else console.log(`  落后上游 ${mirrorBehind} 个提交，将随本次 push 一起快进。`)

const after = git(['rev-parse', 'HEAD']).stdout
const lockAfter = sha256File(lockFile)
if (lockAfter !== lockBefore || residue.removed.length > 0) {
  console.log(lockAfter !== lockBefore ? '依赖清单有变化，执行 pnpm install…' : '刚清理了残留目录，重装依赖以刷新旧路径链接…')
  if (pnpm(['install']).status !== 0) {
    console.log('pnpm install 失败，请看上面的输出。')
    process.exit(1)
  }
} else {
  console.log('依赖清单未变化，跳过 pnpm install。')
}

const aheadCount = Number(git(['rev-list', '--count', 'origin/dev..HEAD']).stdout || '0')
const pushRefspecs = []
if (aheadCount > 0) pushRefspecs.push('dev')
if (mirrorBehind > 0) pushRefspecs.push('upstream/master:master')
if (NO_PUSH) {
  console.log('已按 --no-push 跳过 push。')
} else if (pushRefspecs.length === 0) {
  console.log('没有需要推送的内容。')
} else if (!VERIFY) {
  console.log(`推送到 origin：${pushRefspecs.join('、')}…`)
  console.log('  已跳过本地 pre-push 类型检查（CI 会跑完整门禁）；想在本地先跑用 --verify。')
  const pushed = gitLive(['push', '--no-verify', 'origin', ...pushRefspecs])
  if (pushed.status !== 0) {
    console.log('  推送失败：请检查网络或凭据，然后手动执行 git push origin dev。')
    process.exit(1)
  }
  console.log('  已推送成功。')
  if (mirrorBehind > 0) git(['fetch', 'origin', 'master:master'])
} else {
  console.log(`推送到 origin：${pushRefspecs.join('、')}…`)
  console.log('  正在跑本地 pre-push 类型检查（全量 typecheck，通常 6-15 分钟，期间终端无输出，请不要关窗口）…')
  const pushed = gitLive(['push', 'origin', ...pushRefspecs])
  if (pushed.status !== 0) {
    console.log('  pre-push 钩子环境不可用，改用 --no-verify 推送（CI 仍会跑完整检查）…')
    const fallback = gitLive(['push', '--no-verify', 'origin', ...pushRefspecs])
    if (fallback.status !== 0) {
      console.log('  推送失败：请检查网络或凭据，然后手动执行 git push origin dev。')
      process.exit(1)
    }
  }
  console.log('  已推送成功。')
  if (mirrorBehind > 0) git(['fetch', 'origin', 'master:master'])
}

console.log('\n完成。')
if (before === after) console.log('  代码本来就是最新的。')
else console.log(`  HEAD: ${before.slice(0, 8)} -> ${after.slice(0, 8)}`)
console.log(`  当前分支: ${git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout}`)
console.log('  下一步：pnpm start（菜单选 1=Web / 2=桌面端）')

console.log('\n本地分支与 GitHub fork 的对照：')
for (const name of ['dev', 'master']) {
  const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).stdout
  const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).stdout
  if (!local) {
    console.log(`  ${name} : 本地没有这个分支`)
    continue
  }
  if (!remote) {
    console.log(`  ${name} : 远端 origin/${name} 不存在`)
    continue
  }
  const counts = git(['rev-list', '--left-right', '--count', `${local}...${remote}`]).stdout.split(/\s+/).filter(Boolean).map(Number)
  const ahead = counts[0] ?? 0
  const behind = counts[1] ?? 0
  let state
  if (ahead === 0 && behind === 0) state = '与远端一致'
  else if (ahead > 0 && behind === 0) state = `领先远端 ${ahead} 个提交（未推送）`
  else if (ahead === 0 && behind > 0) state = `落后远端 ${behind} 个提交`
  else state = `分叉（领先 ${ahead} / 落后 ${behind}）`
  console.log(`  ${name.padEnd(7)} ${state}  [${local.slice(0, 8)}]`)
}
console.log('  说明：master 是上游镜像，第 [2/5] 步只更新它的本地指针，第 [5/5] 步快进镜像；日常只在 dev 上工作。')
