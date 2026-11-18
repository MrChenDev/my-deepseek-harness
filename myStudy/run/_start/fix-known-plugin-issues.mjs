#!/usr/bin/env node
/**
 * 修复已知的 dsh 插件兼容问题（跨平台）。
 *
 * 目前覆盖：
 * - dsh-pua 1.0.x：新 Cordis 禁用 ctx.root，插件未捕获该错误导致激活失败。
 *   恢复 inject 列表，并让 ctx.root 报错走插件已有的降级分支。
 * - dsh-pet < 0.4.9：authenticatedUrl API 已移除，升级到 0.4.9。
 * - dsh-island < 0.6.4：升级到 0.6.4。
 * - @michengai/dsh-agency-agents < 1.2.34：升级到 1.2.34。
 * - dsh-reading-collection：当前仍不兼容，只提示，不自动移除。
 *
 * 用法：node fix-known-plugin-issues.mjs [--dry-run]
 */

import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROFILES = ['web', 'desktop']
const PROFILES_ROOT = join(homedir(), '.dsh', 'profiles')
const latestCache = new Map()

/** 比较 semver（含 prerelease）。 */
function compareSemver(a, b) {
  const [aMain, aPre] = a.split('-')
  const [bMain, bPre] = b.split('-')
  const aParts = aMain.split('.').map(Number)
  const bParts = bMain.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (aPre === undefined && bPre === undefined) return 0
  if (aPre === undefined) return 1
  if (bPre === undefined) return -1
  return aPre.localeCompare(bPre, undefined, { numeric: true })
}

/** 读取 JSON，文件不存在时返回 undefined。 */
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/** 读取某个 profile 里已安装包的版本。 */
function installedVersion(profileDir, packageName) {
  return readJson(join(profileDir, 'node_modules', packageName, 'package.json'))?.version
}

/** 查询 npm 上的最新版本；失败时返回 undefined。 */
function latestVersion(profileDir, packageName) {
  const key = `${profileDir}|${packageName}`
  if (latestCache.has(key)) return latestCache.get(key)
  const result = spawnSync('pnpm', ['view', packageName, 'version'], {
    cwd: profileDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const version = result.status === 0
    ? (result.stdout || '').trim().split('\n').filter(Boolean).at(-1)
    : undefined
  latestCache.set(key, version)
  return version
}

/** 移除 profile 里指向源码的 storage link，避免 Windows 上 pnpm 建 symlink 报 EPERM。 */
function removeStorageLinks(profileDir, dryRun) {
  const packageFile = join(profileDir, 'package.json')
  const pkg = readJson(packageFile)
  if (!pkg?.dependencies) return false
  let changed = false
  for (const packageName of ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain']) {
    const spec = pkg.dependencies[packageName]
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    console.log(`  移除 storage link 依赖：${packageName}`)
    delete pkg.dependencies[packageName]
    changed = true
    if (dryRun) continue
    const directory = join(profileDir, 'node_modules', ...packageName.split('/'))
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink()) unlinkSync(directory)
      else rmSync(directory, { recursive: true, force: true })
    }
  }
  if (changed && !dryRun) writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`)
  return changed
}

/** 对 dsh-pua 应用兼容补丁。 */
function patchDshPua(profileDir, dryRun) {
  const base = join(profileDir, 'node_modules', '@michengai', 'dsh-pua', 'lib')
  const indexPath = join(base, 'index.js')
  const runtimePath = join(base, 'runtime.js')
  const changes = []

  if (existsSync(indexPath)) {
    const source = readFileSync(indexPath, 'utf8')
    const patched = source.replace(
      /export const inject = \[[^\]]*\];/,
      "export const inject = ['commands', 'systemPrompt'];",
    )
    if (patched !== source) {
      if (!dryRun) writeFileSync(indexPath, patched)
      changes.push('dsh-pua inject 恢复')
    }
  }

  if (existsSync(runtimePath)) {
    const source = readFileSync(runtimePath, 'utf8')
    if (!source.includes('cannot get property "root" without inject')) {
      const patched = source.replace(
        /\/unavailable from a plugin activation\/u/,
        '/unavailable from a plugin activation|cannot get property "root" without inject/u',
      )
      if (patched !== source) {
        if (!dryRun) writeFileSync(runtimePath, patched)
        changes.push('dsh-pua root 降级')
      }
    }
  }

  return changes
}

/** 版本过低时升级单个包；升级失败只报告，不中断。 */
function upgradeIfNeeded(profileDir, packageName, minimumVersion, dryRun) {
  const current = installedVersion(profileDir, packageName)
  if (current === undefined) return false
  const latest = latestVersion(profileDir, packageName)
  const target = latest !== undefined && compareSemver(latest, minimumVersion) >= 0 ? latest : minimumVersion
  if (compareSemver(current, target) >= 0) return false
  console.log(`  ${packageName} ${current} -> ${target}`)
  if (dryRun) return true
  let result = spawnSync('pnpm', ['add', `${packageName}@${target}`], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0 && target !== minimumVersion) {
    console.log(`  ${packageName} latest 升级失败，回退到最低修复版 ${minimumVersion}`)
    result = spawnSync('pnpm', ['add', `${packageName}@${minimumVersion}`], {
      cwd: profileDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  }
  if (result.status !== 0) {
    console.warn(`  ${packageName} 升级失败，请稍后重试或手动安装。`)
    return false
  }
  return true
}

/**
 * 对已安装的 profile 应用已知插件修复。
 * @param options - `dryRun` 只报告不写文件；`upgrade` 允许自动升级（默认 true）。
 * @returns 是否发生了改动。
 */
export function applyKnownPluginFixes(options = {}) {
  const dryRun = options.dryRun === true
  const upgrade = options.upgrade !== false
  let changed = false

  for (const name of PROFILES) {
    const profileDir = join(PROFILES_ROOT, name)
    if (!existsSync(join(profileDir, 'package.json'))) continue
    console.log(`[${name}]`)

    const storageChanged = removeStorageLinks(profileDir, dryRun)
    if (storageChanged) changed = true

    const puaChanges = patchDshPua(profileDir, dryRun)
    for (const change of puaChanges) {
      console.log(`  ${dryRun ? '将应用' : '已应用'}：${change}`)
      changed = true
    }

    if (storageChanged && !dryRun) {
      const install = spawnSync('pnpm', ['install'], {
        cwd: profileDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
      if (install.status !== 0) console.warn('  pnpm install 失败，请手动检查。')
    }

    if (upgrade) {
      changed = upgradeIfNeeded(profileDir, 'dsh-pet', '0.4.9', dryRun) || changed
      changed = upgradeIfNeeded(profileDir, 'dsh-island', '0.6.4', dryRun) || changed
      changed = upgradeIfNeeded(profileDir, '@michengai/dsh-agency-agents', '1.2.34', dryRun) || changed
    }

    if (installedVersion(profileDir, 'dsh-reading-collection') !== undefined) {
      console.warn('  dsh-reading-collection 当前仍不兼容，建议等作者更新后再启用。')
    }
  }

  if (!changed) console.log('没有需要修复的已知插件问题。')
  return changed
}

if (import.meta.main) {
  applyKnownPluginFixes({ dryRun: process.argv.includes('--dry-run') })
}
