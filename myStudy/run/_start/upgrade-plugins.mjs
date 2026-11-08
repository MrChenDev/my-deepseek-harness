#!/usr/bin/env node
/**
 * 把 dsh 的 desktop / web profile 插件升级到最新，并检查它们声明的
 * @deepseek-ai/dsh-* peer 是否覆盖当前运行时版本。跨平台实现。
 *
 * 用法：node upgrade-plugins.mjs [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..')
const PROFILES_ROOT = join(homedir(), '.dsh', 'profiles')
const PROFILES = ['desktop', 'web']
const DRY_RUN = process.argv.includes('--dry-run')
const runtimeVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version

/** 执行命令并返回结果。 */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options })
}

/** 读取 JSON，文件不存在时返回 undefined。 */
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/** 读取已安装版本。 */
function installedVersion(directory, packageName) {
  return readJson(join(directory, 'node_modules', packageName, 'package.json'))?.version
}

/** 保守判断 peer 版本区间是否覆盖当前 dsh 版本（与 PowerShell 版逻辑一致）。 */
function peerCoverage(range, version) {
  if (!range) return true
  if (range === '*' || range.startsWith('workspace:')) return true
  if (range.includes(version)) return true
  const parts = version.split('.')
  if (parts.length >= 2) {
    const prefix = `${parts[0]}.${parts[1]}.`.replace(/\./g, '\\.')
    if (new RegExp(`(?:\\^|~|>=)\\s*${prefix}`).test(range)) return true
  }
  return false
}

/** 读取插件声明的 @deepseek-ai/dsh-* peer。 */
function dshPeers(directory, packageName) {
  const manifest = readJson(join(directory, 'node_modules', packageName, 'package.json'))
  const peers = manifest?.peerDependencies ?? {}
  return Object.fromEntries(Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-')))
}

console.log(`当前 dsh 运行时版本: ${runtimeVersion}`)
console.log(`profile 根目录: ${PROFILES_ROOT}${DRY_RUN ? '（--dry-run，只检查）' : ''}`)

const exemptions = []

for (const profileName of PROFILES) {
  const directory = join(PROFILES_ROOT, profileName)
  console.log(`\n[${profileName}] ${directory}`)
  if (!existsSync(directory)) {
    console.log('  该 profile 不存在，跳过。')
    continue
  }
  const pkg = readJson(join(directory, 'package.json'))
  const dependencies = pkg?.dependencies ?? {}
  const packages = Object.keys(dependencies).sort()
  if (packages.length === 0) {
    console.log('  没有安装任何插件，跳过。')
    continue
  }
  const before = Object.fromEntries(packages.map(name => [name, installedVersion(directory, name)]))

  if (!DRY_RUN) {
    console.log('  升级中（pnpm update --latest）…')
    const update = run('pnpm', ['update', '--latest'], { cwd: directory })
    const tail = (update.stdout || '').trim().split('\n').filter(Boolean).slice(-4)
    for (const line of tail) console.log(`  ${line}`)
    if (update.status !== 0) {
      console.error('  升级失败。')
      console.error((update.stderr || '').trim())
      process.exit(1)
    }
  }

  console.log('  插件版本：')
  for (const packageName of packages) {
    const after = installedVersion(directory, packageName)
    const oldVersion = before[packageName] ?? '未安装'
    const newVersion = after ?? '未安装'
    console.log(`    ${packageName.padEnd(28)} ${oldVersion} -> ${newVersion}`)
    const peers = dshPeers(directory, packageName)
    const unsatisfied = Object.entries(peers)
      .filter(([, range]) => !peerCoverage(range, runtimeVersion))
      .map(([peer, range]) => `${peer}（要求 ${range}）`)
    if (unsatisfied.length > 0) {
      console.log(`      不兼容的 peer：${unsatisfied.join('、')}`)
      if (after) exemptions.push({ profile: profileName, package: packageName, version: after })
    }
  }
}

if (exemptions.length > 0) {
  console.log('\n以下插件升级后仍未覆盖当前 dsh 版本（作者可能还没适配）：')
  for (const item of exemptions) console.log(`  ${item.package}@${item.version}（${item.profile}）`)
  console.log('如确认要继续用（接受“可能崩溃或数据丢失”的风险），可复制下面的命令放行：')
  for (const item of exemptions) {
    console.log(`  pnpm dsh plugin --profile ${item.profile} allow-version ${item.package}@${item.version} --dsh-version ${runtimeVersion} --accept-risk`)
  }
  console.log('查看或撤销豁免：pnpm dsh plugin --profile <desktop|web> version-exemptions / revoke-version …')
} else {
  console.log('\n所有插件的 peer 声明都覆盖当前 dsh 版本。')
}

console.log('\n下一步：重启桌面端 / 重启 Web（pnpm dsh web）。')
