#!/usr/bin/env node
/**
 * 为 dsh 的 desktop / web profile 安装或升级 dshmarket。
 * 跨平台实现：pnpm-workspace.yaml 补齐 allowBuilds 与 minimumReleaseAgeExclude，
 * 把 git 依赖替换成 npm 发布版，再执行 pnpm add dshmarket@<latest>。
 *
 * 用法：node install-dshmarket.mjs [--dry-run]
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const PACKAGE = 'dshmarket'
const GIT_URL = 'https://github.com/dsh-market/dsh-market.git'
const PROFILES = ['desktop', 'web']
const DRY_RUN = process.argv.includes('--dry-run')
const PROFILES_ROOT = join(homedir(), '.dsh', 'profiles')

/** 执行命令并返回结果。 */
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options })
}

/** 读取 JSON，文件不存在时返回 undefined。 */
function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/** 查询 dshmarket 的最新版本。 */
function latestVersion() {
  const result = run('pnpm', ['view', PACKAGE, 'version'])
  if (result.status !== 0) {
    console.error(`无法查询 ${PACKAGE} 的最新版本：`)
    console.error((result.stderr || result.stdout || '').trim())
    process.exit(1)
  }
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean)
  return lines[lines.length - 1].trim()
}

/** 补齐 pnpm-workspace.yaml 里的 allowBuilds 与 minimumReleaseAgeExclude。 */
function updateWorkspace(directory, latest) {
  const file = join(directory, 'pnpm-workspace.yaml')
  const workspace = existsSync(file)
    ? (yaml.load(readFileSync(file, 'utf8')) ?? {})
    : { packages: ['.'] }
  workspace.allowBuilds = { ...(workspace.allowBuilds ?? {}), [PACKAGE]: true, [`${PACKAGE}@${GIT_URL}`]: true }
  const lockFile = join(directory, 'pnpm-lock.yaml')
  if (existsSync(lockFile)) {
    const match = readFileSync(lockFile, 'utf8').match(/https:\/\/codeload\.github\.com\/[^\s"']+/)
    if (match) workspace.allowBuilds[`${PACKAGE}@${match[0]}`] = true
  }
  const exclude = new Set(workspace.minimumReleaseAgeExclude ?? [])
  exclude.add(`${PACKAGE}@${latest}`)
  workspace.minimumReleaseAgeExclude = [...exclude]
  if (!DRY_RUN) writeFileSync(file, yaml.dump(workspace, { lineWidth: -1, noRefs: true, sortKeys: false }))
}

/** 读取 package.json 里 dshmarket 的依赖声明。 */
function declaredSpec(directory) {
  const pkg = readJson(join(directory, 'package.json'))
  return pkg?.dependencies?.[PACKAGE]
}

/** 读取已安装版本。 */
function installedVersion(directory) {
  return readJson(join(directory, 'node_modules', PACKAGE, 'package.json'))?.version ?? '未安装'
}

const latest = latestVersion()
console.log(`DSH profile 根目录: ${PROFILES_ROOT}`)
console.log(`${PACKAGE} 最新版本: ${latest}${DRY_RUN ? '（--dry-run，只检查）' : ''}`)

const installed = {}
for (const name of PROFILES) {
  const directory = join(PROFILES_ROOT, name)
  console.log(`\n[${name}] ${directory}`)
  if (!existsSync(directory)) {
    console.log('  该 profile 不存在，跳过。')
    continue
  }
  updateWorkspace(directory, latest)
  console.log('  已补齐 pnpm-workspace.yaml 的白名单。')
  const spec = declaredSpec(directory)
  if (spec && /^(github:|git:|https?:)/.test(spec)) {
    console.log(`  当前是 git 依赖（${spec}），${DRY_RUN ? '将' : '先'}移除再装 npm 版。`)
    if (!DRY_RUN) {
      const remove = run('pnpm', ['remove', PACKAGE], { cwd: directory, stdio: 'inherit' })
      if (remove.status !== 0) {
        console.error('  移除 git 依赖失败。')
        process.exit(1)
      }
    }
  }
  if (!DRY_RUN) {
    const add = run('pnpm', ['add', `${PACKAGE}@${latest}`], { cwd: directory, stdio: 'inherit' })
    if (add.status !== 0) {
      console.error('  安装失败。')
      process.exit(1)
    }
  }
  installed[name] = installedVersion(directory)
}

console.log('\n完成。当前各 profile 版本：')
for (const name of PROFILES) console.log(`  ${name.padEnd(8)} ${installed[name] ?? '未安装'}`)
console.log('  下一步：重启桌面端/Web 端，在插件页启用该插件。')
