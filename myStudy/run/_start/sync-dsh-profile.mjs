#!/usr/bin/env node
/**
 * 跨机器同步 dsh 的插件声明、profile 配置和 skills。
 *
 * 只同步“声明”：package.json 的 dependencies/bundles、pnpm-workspace.yaml 的安装约束、
 * cordis.patch.yml 的配置覆盖，以及 ~/.dsh/skills 下的 skill 文件。
 * node_modules、会话、凭据、存储数据都不进入仓库。
 *
 * 用法：
 *   node sync-dsh-profile.mjs           一键同步（应用基线 → 导出本机 → 提交推送 → 装依赖）
 *   node sync-dsh-profile.mjs export    把本机状态合并进仓库基线
 *   node sync-dsh-profile.mjs apply     把仓库基线合并进本机
 *   node sync-dsh-profile.mjs diff      只显示差异，不写文件
 *   ... apply --force-skill <名称>      同名 skill 内容不同时强制用基线覆盖本机
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')
const DSH_HOME = join(homedir(), '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')
const BASELINE_PATH = join(SCRIPT_DIR, 'dsh-profile-baseline.json')
const SKILLS_BASELINE_DIR = join(SCRIPT_DIR, 'dsh-skills')
const BACKUP_ROOT = join(DSH_HOME, 'backups')
const REPO_PLACEHOLDER = '${DSH_REPO}'
const DEFAULT_PROFILES = ['web', 'desktop']
const PROFILE_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']

const PROFILES = (process.env.DSH_SYNC_PROFILES ?? DEFAULT_PROFILES.join(','))
  .split(',')
  .map(name => name.trim())
  .filter(Boolean)

const SKILL_EXCLUDE_DIRS = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv'])
const SKILL_EXCLUDE_FILE = /(^|[\\/])(__pycache__|node_modules|\.git|\.venv|venv)([\\/]|$)|\.pyc$|\.DS_Store$|\.log$|\.tmp$/i

/** 打印普通信息。 */
function info(message) {
  console.log(message)
}

/** 打印警告。 */
function warn(message) {
  console.warn(`[警告] ${message}`)
}

/** 读取 JSON，文件不存在时返回 undefined。 */
function readJsonFile(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 以两个空格缩进写回 JSON，并保留结尾换行。 */
function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 读取 YAML，文件不存在时返回 undefined。 */
function readYamlFile(path) {
  if (!existsSync(path)) return undefined
  return yaml.load(readFileSync(path, 'utf8'))
}

/** 写回 YAML，保持长行不折行。 */
function writeYamlFile(path, value) {
  writeFileSync(path, yaml.dump(value, { lineWidth: -1, noRefs: true, sortKeys: false }))
}

/** 内容相同即视为没有变化，避免无谓改写文件格式。 */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 空基线。 */
function emptyBaseline() {
  return {
    version: 1,
    updatedAt: undefined,
    updatedBy: undefined,
    globalPatch: [],
    profiles: {},
    skills: [],
  }
}

/** 读取仓库基线，不存在时返回空基线。 */
function loadBaseline() {
  const baseline = readJsonFile(BASELINE_PATH)
  return baseline ? { ...emptyBaseline(), ...baseline } : emptyBaseline()
}

/** 把本机仓库内的 link: 路径编码成跨机器占位符。 */
function encodeSpec(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return spec
  const target = spec.slice('link:'.length)
  const absolute = isAbsolute(target) ? resolve(target) : resolve(REPO_ROOT, target)
  const rel = relative(REPO_ROOT, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return spec
  return `link:${REPO_PLACEHOLDER}/${rel.split(sep).join('/')}`
}

/** 把跨机器占位符还原成本机仓库路径。 */
function decodeSpec(spec) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return spec
  const target = spec.slice('link:'.length)
  if (!target.startsWith(REPO_PLACEHOLDER)) return spec
  const rel = target.slice(REPO_PLACEHOLDER.length).replace(/^\/+/, '')
  return `link:${join(REPO_ROOT, ...rel.split('/')).split(sep).join('/')}`
}

/** 数组并集，保持先后顺序。 */
function unionArray(a, b) {
  const out = []
  for (const value of [...(a ?? []), ...(b ?? [])]) {
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** 去掉为空的 workspace 键，避免给没有该键的 profile 凭空添加 `overrides: {}`。 */
function compactWorkspace(workspace) {
  const out = { ...workspace }
  if (out.allowBuilds && Object.keys(out.allowBuilds).length === 0) delete out.allowBuilds
  if (Array.isArray(out.minimumReleaseAgeExclude) && out.minimumReleaseAgeExclude.length === 0) delete out.minimumReleaseAgeExclude
  if (out.overrides && Object.keys(out.overrides).length === 0) delete out.overrides
  return out
}

/**
 * 保留合并两个映射：已有键保留，新键加入；同名但值不同只报告冲突。
 * @param {Record<string, unknown>} target 合并目标（冲突时保留它的值）。
 * @param {Record<string, unknown>} incoming 待合并的声明。
 * @param {string} label 报告用的位置名称。
 * @param {string[]} conflicts 冲突收集器。
 * @returns {Record<string, unknown>}
 */
function mergeRecord(target, incoming, label, conflicts, preferIncoming = false) {
  const out = { ...(target ?? {}) }
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!(key in out)) {
      out[key] = value
      continue
    }
    if (!same(out[key], value)) {
      conflicts.push(`${label}: ${key}\n    保留: ${JSON.stringify(out[key])}\n    未采用: ${JSON.stringify(value)}`)
      if (preferIncoming) out[key] = value
    }
  }
  return out
}

/**
 * 按 id 保留合并 patch 条目。
 * @param {Array<Record<string, unknown>>} target 合并目标（冲突时保留它的条目）。
 * @param {Array<Record<string, unknown>>} incoming 待合并的条目。
 * @param {string} label 报告用的位置名称。
 * @param {string[]} conflicts 冲突收集器。
 * @returns {Array<Record<string, unknown>>}
 */
function mergePatchEntries(target, incoming, label, conflicts, preferIncoming = false) {
  const out = [...(target ?? [])]
  for (const entry of incoming ?? []) {
    // 全局 patch 常用 `{ insert: [...] }` 批量结构：按内部条目 id 合并。
    if (Array.isArray(entry?.insert)) {
      const existing = out.find(item => Array.isArray(item?.insert))
      if (existing) {
        existing.insert = mergePatchEntries(existing.insert, entry.insert, `${label}/insert`, conflicts)
        continue
      }
      out.push(entry)
      continue
    }
    const id = entry?.id
    if (!id) {
      if (out.some(item => same(item, entry))) continue
      out.push(entry)
      continue
    }
    const index = out.findIndex(item => item?.id === id)
    if (index === -1) {
      out.push(entry)
      continue
    }
    if (!same(out[index], entry)) {
      conflicts.push(`${label}: id=${id} 配置不同，保留已有条目`)
      if (preferIncoming) out[index] = entry
    }
  }
  return out
}

/** 读取一个本机 profile 的声明。 */
function readLocalProfile(name) {
  const dir = join(PROFILES_DIR, name)
  const pkg = readJsonFile(join(dir, 'package.json'))
  if (!pkg) return undefined
  const workspace = readYamlFile(join(dir, 'pnpm-workspace.yaml')) ?? {}
  const patch = readYamlFile(join(dir, 'cordis.patch.yml')) ?? []
  return {
    dependencies: pkg.dependencies ?? {},
    bundles: pkg.dsh?.profile?.bundles ?? [],
    workspace: {
      allowBuilds: workspace.allowBuilds ?? {},
      minimumReleaseAgeExclude: workspace.minimumReleaseAgeExclude ?? [],
      overrides: workspace.overrides ?? {},
    },
    patch: Array.isArray(patch) ? patch : [],
    packageJson: pkg,
    workspaceYaml: workspace,
  }
}

/** 把本机 skills 复制进基线，同名目录内容不同时报告冲突。 */
function exportSkills(baseline, conflicts) {
  const source = join(DSH_HOME, 'skills')
  if (!existsSync(source)) return baseline.skills
  mkdirSync(SKILLS_BASELINE_DIR, { recursive: true })
  const names = readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  for (const name of names) {
    const from = join(source, name)
    const to = join(SKILLS_BASELINE_DIR, name)
    if (existsSync(to) && !same(dirDigest(from), dirDigest(to))) {
      conflicts.push(`skills/${name}: 基线里已有同名 skill 且内容不同，保留基线版本`)
      continue
    }
    cpSync(from, to, { recursive: true, force: true, filter: path => !SKILL_EXCLUDE_FILE.test(path) })
    info(`  已导出 skill: ${name}`)
  }
  return unionArray(baseline.skills, names)
}

/** 目录内容摘要：相对路径 -> 文件 sha256，用于判断 skill 是否有差异。 */
function dirDigest(dir) {
  const files = {}
  if (!existsSync(dir)) return files
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SKILL_EXCLUDE_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (SKILL_EXCLUDE_FILE.test(rel)) continue
      files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
  }
  walk(dir, '')
  return files
}

/** 把本机状态导出并保留合并进仓库基线。 */
function exportBaseline() {
  const baseline = loadBaseline()
  const conflicts = []
  for (const name of PROFILES) {
    const local = readLocalProfile(name)
    if (!local) {
      warn(`本机没有 profile ${name}，跳过`)
      continue
    }
    const previous = baseline.profiles[name] ?? {}
    const dependencies = { ...(previous.dependencies ?? {}) }
    for (const [key, value] of Object.entries(local.dependencies)) {
      const encoded = encodeSpec(value)
      if (key in dependencies && !same(dependencies[key], encoded)) {
        conflicts.push(`profiles/${name}/dependencies: ${key}\n    基线: ${dependencies[key]}\n    本机: ${encoded}`)
        continue
      }
      dependencies[key] = encoded
    }
    const workspace = previous.workspace ?? {}
    baseline.profiles[name] = {
      dependencies,
      bundles: unionArray(previous.bundles, local.bundles),
      workspace: compactWorkspace({
        allowBuilds: mergeRecord(workspace.allowBuilds ?? {}, local.workspace.allowBuilds, `profiles/${name}/workspace.allowBuilds`, conflicts),
        minimumReleaseAgeExclude: unionArray(workspace.minimumReleaseAgeExclude, local.workspace.minimumReleaseAgeExclude),
        overrides: mergeRecord(workspace.overrides ?? {}, local.workspace.overrides, `profiles/${name}/workspace.overrides`, conflicts),
      }),
      patch: mergePatchEntries(previous.patch ?? [], local.patch, `profiles/${name}/cordis.patch.yml`, conflicts),
    }
    info(`已导出 profile: ${name}（${Object.keys(local.dependencies).length} 个依赖，${local.bundles.length} 个 bundle）`)
  }

  const globalPatch = readYamlFile(join(DSH_HOME, 'cordis.patch.yml')) ?? []
  baseline.globalPatch = mergePatchEntries(baseline.globalPatch, Array.isArray(globalPatch) ? globalPatch : [], '~/.dsh/cordis.patch.yml', conflicts)
  baseline.skills = exportSkills(baseline, conflicts)
  baseline.updatedAt = new Date().toISOString()
  baseline.updatedBy = hostname()
  writeJsonFile(BASELINE_PATH, baseline)
  info(`\n基线已写入：${BASELINE_PATH}`)
  reportConflicts(conflicts)
}

/** 把仓库基线合并进本机 profile，并在有变化时安装依赖。 */
function applyBaseline(options) {
  const baseline = readBaselineOrExit()
  const conflicts = []
  const backupDirs = []
  const installTargets = []

  for (const name of PROFILES) {
    const base = baseline.profiles?.[name]
    if (!base) continue
    const dir = join(PROFILES_DIR, name)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) {
      warn(`本机没有 profile ${name}，跳过`)
      continue
    }
    const local = readLocalProfile(name)
    const dependencies = mergeRecord(local.dependencies, mapSpecs(base.dependencies, decodeSpec), `profiles/${name}/dependencies`, conflicts)
    const bundles = unionArray(local.bundles, base.bundles)
    const workspace = compactWorkspace({
      ...local.workspaceYaml,
      allowBuilds: mergeRecord(local.workspace.allowBuilds, base.workspace?.allowBuilds ?? {}, `profiles/${name}/workspace.allowBuilds`, conflicts),
      minimumReleaseAgeExclude: unionArray(local.workspace.minimumReleaseAgeExclude, base.workspace?.minimumReleaseAgeExclude ?? []),
      overrides: mergeRecord(local.workspace.overrides, base.workspace?.overrides ?? {}, `profiles/${name}/workspace.overrides`, conflicts),
    })
    const patch = mergePatchEntries(local.patch, base.patch ?? [], `profiles/${name}/cordis.patch.yml`, conflicts)
    const nextPkg = { ...local.packageJson, dependencies }
    nextPkg.dsh = { ...(local.packageJson.dsh ?? {}), profile: { ...(local.packageJson.dsh?.profile ?? {}), bundles } }
    const changed = !same(local.dependencies, dependencies) || !same(local.bundles, bundles) || !same(local.workspaceYaml, workspace) || !same(local.patch, patch)
    if (!changed) {
      info(`profile ${name} 已是最新`)
      continue
    }
    backupDirs.push(backupProfile(name))
    writeJsonFile(pkgPath, nextPkg)
    writeYamlFile(join(dir, 'pnpm-workspace.yaml'), workspace)
    writeYamlFile(join(dir, 'cordis.patch.yml'), patch)
    installTargets.push(dir)
    info(`已更新 profile: ${name}`)
  }

  const globalPatchPath = join(DSH_HOME, 'cordis.patch.yml')
  const localGlobalPatch = readYamlFile(globalPatchPath) ?? []
  const nextGlobalPatch = mergePatchEntries(localGlobalPatch, baseline.globalPatch ?? [], '~/.dsh/cordis.patch.yml', conflicts)
  if (!same(localGlobalPatch, nextGlobalPatch)) {
    backupFile(globalPatchPath)
    writeYamlFile(globalPatchPath, nextGlobalPatch)
    info('已更新全局 cordis.patch.yml')
  }
  if (process.platform !== 'win32' && JSON.stringify(nextGlobalPatch).includes('cmd.exe')) {
    warn('全局 cordis.patch.yml 含 Windows 专用的 cmd.exe 条目，Linux 上该插件可能无法启动；请按平台调整或禁用该条目。')
  }

  applySkills(baseline, conflicts, options)

  if (options.install !== false) installProfiles(installTargets)

  if (backupDirs.length > 0) info(`\n备份已保存到：${backupDirs.join('、')}`)
  reportConflicts(conflicts)
  return { installTargets }
}

/** 只显示差异：列出将新增和冲突的声明，不写文件。 */
function diffBaseline() {
  const baseline = readBaselineOrExit()
  const conflicts = []
  for (const name of PROFILES) {
    const base = baseline.profiles?.[name]
    if (!base) continue
    const local = readLocalProfile(name)
    if (!local) {
      info(`profile ${name}: 本机不存在，应用时会跳过`)
      continue
    }
    const dependencies = mergeRecord(local.dependencies, mapSpecs(base.dependencies, decodeSpec), `profiles/${name}/dependencies`, conflicts)
    const bundles = unionArray(local.bundles, base.bundles)
    const workspace = compactWorkspace({
      ...local.workspaceYaml,
      allowBuilds: mergeRecord(local.workspace.allowBuilds, base.workspace?.allowBuilds ?? {}, `profiles/${name}/workspace.allowBuilds`, conflicts),
      minimumReleaseAgeExclude: unionArray(local.workspace.minimumReleaseAgeExclude, base.workspace?.minimumReleaseAgeExclude ?? []),
      overrides: mergeRecord(local.workspace.overrides, base.workspace?.overrides ?? {}, `profiles/${name}/workspace.overrides`, conflicts),
    })
    const patch = mergePatchEntries(local.patch, base.patch ?? [], `profiles/${name}/cordis.patch.yml`, conflicts)
    const addedDeps = Object.keys(dependencies).filter(key => !(key in local.dependencies))
    const addedBundles = bundles.filter(bundle => !local.bundles.includes(bundle))
    const addedPatch = patch.filter(entry => !local.patch.some(localEntry => localEntry?.id === entry?.id))
    info(`\nprofile ${name}:`)
    info(`  新增依赖: ${addedDeps.length ? addedDeps.join(', ') : '无'}`)
    info(`  新增 bundle: ${addedBundles.length ? addedBundles.join(', ') : '无'}`)
    info(`  新增 patch: ${addedPatch.length ? addedPatch.map(entry => entry.id).join(', ') : '无'}`)
    info(`  workspace: ${same(workspace, local.workspaceYaml) ? '无变化' : '有变化'}`)
  }
  info('\nskills 基线:')
  const localSkills = existsSync(join(DSH_HOME, 'skills'))
    ? readdirSync(join(DSH_HOME, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    : []
  for (const name of baseline.skills ?? []) {
    if (!localSkills.includes(name)) info(`  将安装: ${name}`)
    else if (!same(dirDigest(join(DSH_HOME, 'skills', name)), dirDigest(join(SKILLS_BASELINE_DIR, name)))) info(`  内容不同: ${name}`)
  }
  reportConflicts(conflicts)
}

/** 把基线里的 skills 合并进本机。 */
function applySkills(baseline, conflicts, options) {
  if (!existsSync(SKILLS_BASELINE_DIR)) return
  const targetRoot = join(DSH_HOME, 'skills')
  mkdirSync(targetRoot, { recursive: true })
  for (const name of baseline.skills ?? []) {
    const from = join(SKILLS_BASELINE_DIR, name)
    const to = join(targetRoot, name)
    if (!existsSync(from)) continue
    if (existsSync(to) && !same(dirDigest(from), dirDigest(to))) {
      if (options.forceSkills.includes(name)) {
        cpSync(from, to, { recursive: true, force: true, filter: path => !SKILL_EXCLUDE_FILE.test(path) })
        info(`已强制覆盖 skill: ${name}`)
      } else {
        conflicts.push(`skills/${name}: 本机已有同名 skill 且内容不同，保留本机版本（需要覆盖时加 --force-skill ${name}）`)
      }
      continue
    }
    if (!existsSync(to)) {
      cpSync(from, to, { recursive: true, force: true, filter: path => !SKILL_EXCLUDE_FILE.test(path) })
      info(`已安装 skill: ${name}`)
    }
  }
}

/** 给一个 profile 的三个声明文件做备份。 */
function backupProfile(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(BACKUP_ROOT, `profile-sync-${stamp}`, name)
  mkdirSync(target, { recursive: true })
  for (const file of PROFILE_FILES) {
    const source = join(PROFILES_DIR, name, file)
    if (existsSync(source)) cpSync(source, join(target, file))
  }
  return target
}

/** 备份单个文件。 */
function backupFile(source) {
  if (!existsSync(source)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(BACKUP_ROOT, `profile-sync-${stamp}`)
  mkdirSync(target, { recursive: true })
  cpSync(source, join(target, 'cordis.patch.global.yml'))
}

/** 把映射里的每个字符串值交给转换函数。 */
function mapSpecs(record, transform) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, transform(value)]))
}

/** 读取基线；不存在时给出明确提示并退出。 */
function readBaselineOrExit() {
  const baseline = readJsonFile(BASELINE_PATH)
  if (!baseline) {
    warn(`没有找到基线文件：${BASELINE_PATH}\n请先运行 export 生成基线。`)
    process.exit(1)
  }
  return baseline
}

/** 打印冲突列表。 */
function reportConflicts(conflicts) {
  if (conflicts.length === 0) {
    info('\n没有发现冲突。')
    return
  }
  warn(`发现 ${conflicts.length} 处冲突（按“保留合并”处理，未自动覆盖）：`)
  for (const conflict of conflicts) info(`  - ${conflict}`)
}

/** 对需要重建依赖的 profile 执行 pnpm install。 */
function installProfiles(dirs) {
  for (const dir of dirs) {
    info(`\n在 ${dir} 执行 pnpm install …`)
    const result = spawnSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) warn(`pnpm install 失败（${dir}），请手动检查`)
  }
}

/** 运行 git，返回退出码和输出。 */
function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

/** 一键双向同步：拉取基线 → 应用到本机 → 导出本机 → 提交并推送 → 安装依赖。 */
function syncAll(options) {
  info('[1/5] 检查仓库状态…')
  const dirty = runGit(['status', '--porcelain']).stdout
  if (dirty) {
    const allowed = ['myStudy/run/_start/dsh-profile-baseline.json', 'myStudy/run/_start/dsh-skills']
    const others = dirty.split('\n').filter(line => !allowed.some(path => line.includes(path)))
    if (others.length > 0) {
      warn('仓库还有未提交改动，先处理后再一键同步：')
      for (const line of others.slice(0, 10)) info(`  ${line}`)
      process.exit(1)
    }
  }

  info('[2/5] 拉取远端…')
  const fetch = runGit(['fetch', 'origin', '--quiet'])
  if (fetch.code !== 0) warn(`git fetch 失败：${fetch.stderr}`)
  const behind = Number(runGit(['rev-list', '--count', 'HEAD..origin/dev']).stdout || '0')
  if (behind > 0) {
    if (dirty) {
      warn('本地有未提交改动，无法快进；先提交或暂存后再同步。')
      process.exit(1)
    }
    const merge = runGit(['merge', '--ff-only', 'origin/dev'])
    if (merge.code !== 0) {
      warn(`快进失败：${merge.stderr}`)
      process.exit(1)
    }
    info(`  已快进 ${behind} 个提交`)
  } else {
    info('  已是最新代码')
  }

  info('[3/5] 应用仓库基线到本机…')
  const applied = applyBaseline({ forceSkills: options.forceSkills, install: false })

  info('[4/5] 导出本机状态到基线…')
  exportBaseline()

  info('[5/5] 提交并推送基线…')
  const paths = ['myStudy/run/_start/dsh-profile-baseline.json', 'myStudy/run/_start/dsh-skills']
  const changed = runGit(['status', '--porcelain', '--', ...paths]).stdout
  if (!changed) {
    info('  基线没有变化')
  } else {
    runGit(['add', '--', ...paths])
    const commit = runGit(['commit', '--no-verify', '-m', `chore(dsh-profile): sync plugins from ${hostname()}`, '--', ...paths])
    if (commit.code !== 0) {
      warn(`提交失败：${commit.stderr || commit.stdout}`)
    } else {
      const push = runGit(['push', '--no-verify', 'origin', 'dev'])
      if (push.code !== 0) warn(`推送失败：${push.stderr}\n先双击 pull-latest.cmd 同步后再试。`)
      else info('  已提交并推送基线')
    }
  }

  installProfiles(applied.installTargets)
  info('\n同步完成。现在可以 pnpm start。')
}

const args = process.argv.slice(2)
const mode = ['sync', 'export', 'apply', 'diff'].includes(args[0]) ? args[0] : 'sync'
const forceIndex = args.indexOf('--force-skill')
const forceSkills = forceIndex === -1 ? [] : args.slice(forceIndex + 1).filter(arg => !arg.startsWith('--'))
if (mode === 'export') exportBaseline()
else if (mode === 'apply') applyBaseline({ forceSkills })
else if (mode === 'diff') diffBaseline()
else syncAll({ forceSkills })
