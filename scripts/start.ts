/**
 * Interactive launcher for the two runnable surfaces of this workspace.
 *
 * `pnpm start` prints a Web/Desktop menu, checks the machine's memory headroom,
 * builds when the artifacts are missing or older than the checked-out commit or
 * source edits, then hands the terminal to the surface command so its own URL,
 * port, and window output stay visible. A surface can be named directly
 * (`pnpm start web`) for scripted use, and `--dry-run` prints the plan and the
 * memory snapshot without building or launching anything.
 */

import { execFileSync, spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { removeStalePackageResidue } from './stale-package-residue.ts'

type SurfaceName = 'web' | 'desktop'

interface Surface {
  /** Menu label. */
  readonly label: string
  /** Default listening port printed next to the menu entry. */
  readonly port: number
  /** Built artifacts whose absence forces a build. */
  readonly artifacts: readonly string[]
  /** `pnpm run` script that launches the surface in the foreground. */
  readonly script: string
}

/** Windows memory figures that predict a fatal TypeScript build allocation. */
interface MemorySnapshot {
  /** Physical memory Windows reports as free, in gigabytes. */
  readonly freePhysicalGb: number
  /** Commit charge currently in use, in gigabytes. */
  readonly commitUsedGb: number
  /** Commit limit (physical memory plus page file), in gigabytes. */
  readonly commitLimitGb: number
}

/** Build outputs recorded in the launch stamp after a successful build. */
const STAMP_FILE = '.dsh-build/start-stamp.json'

/** Source trees whose uncommitted edits make the built artifacts stale. */
const SOURCE_ROOTS = ['packages', 'apps', 'vendor', 'native'] as const

/** Commit headroom below this bound risks the fatal zone allocation `tsc` reports. */
const COMMIT_HEADROOM_FLOOR_GB = 8

/** Cooperative lock keeping two launchers from writing the same build trees. */
const BUILD_LOCK_FILE = '.dsh-build/build.lock'

/** Output tail retained for diagnosing a failed build. */
const BUILD_TAIL_LINES = 300

/** Exit status a Windows process reports after a fatal V8 allocation failure. */
const OOM_EXIT_CODE = 2147483651

/** Storage packages may also be installed in a user's Web profile, ahead of this checkout's copies. */
const WEB_PROFILE_STORAGE_PACKAGES = [
  { name: '@deepseek-ai/dsh-storage', manifest: 'packages/storage/storage/package.json' },
  { name: '@deepseek-ai/dsh-storage-domain', manifest: 'packages/storage/storage-domain/package.json' },
] as const

const OOM_SIGNATURE = /Fatal process out of memory|JavaScript heap out of memory|Zone allocation/iu

const MEMORY_QUERY = [
  '$os = Get-CimInstance Win32_OperatingSystem',
  '[pscustomobject]@{',
  'freePhysicalGb = [math]::Round($os.FreePhysicalMemory / 1MB, 2)',
  'commitUsedGb = [math]::Round(($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB, 2)',
  'commitLimitGb = [math]::Round($os.TotalVirtualMemorySize / 1MB, 2)',
  '} | ConvertTo-Json -Compress',
].join('\n')

const SURFACES: Readonly<Record<SurfaceName, Surface>> = {
  web: {
    label: 'Web 端（浏览器）',
    port: 3080,
    artifacts: ['apps/web/dist/index.html'],
    script: 'start:web',
  },
  desktop: {
    label: '桌面端（Electron 窗口）',
    port: 19387,
    artifacts: ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js'],
    script: 'start:desktop',
  },
}

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface LaunchOptions {
  readonly surface: SurfaceName | undefined
  readonly forceBuild: boolean
  readonly skipBuild: boolean
  readonly ignoreMemory: boolean
  readonly dryRun: boolean
  readonly forwarded: readonly string[]
}

function gitLines(gitArguments: readonly string[]): string[] {
  const output = execFileSync('git', [...gitArguments], { cwd: repositoryRoot, encoding: 'utf8' })
  return output.split('\n').filter(line => line !== '')
}

function parseArguments(argv: readonly string[]): LaunchOptions {
  let surface: SurfaceName | undefined
  const forwarded: string[] = []
  let forceBuild = false
  let skipBuild = false
  let ignoreMemory = false
  let dryRun = false
  for (const argument of argv) {
    if (argument === 'web' || argument === 'desktop') surface = argument
    else if (argument === '--force-build') forceBuild = true
    else if (argument === '--skip-build') skipBuild = true
    else if (argument === '--ignore-memory') ignoreMemory = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--') continue
    else forwarded.push(argument)
  }
  return { surface, forceBuild, skipBuild, ignoreMemory, dryRun, forwarded }
}

async function chooseSurface(): Promise<SurfaceName> {
  if (!process.stdin.isTTY) {
    throw new Error('无法选择端：请显式指定 `pnpm start web` 或 `pnpm start desktop`')
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const names = Object.keys(SURFACES) as SurfaceName[]
    console.log('请选择要启动的端：')
    names.forEach((name, index) => {
      console.log(`  ${String(index + 1)}) ${SURFACES[name].label}   —— 端口 ${String(SURFACES[name].port)}`)
    })
    const answer = (await readline.question('输入 1 或 2（直接回车 = 1）: ')).trim().toLowerCase()
    if (answer === '' || answer === '1' || answer === 'web' || answer === 'w') return 'web'
    if (answer === '2' || answer === 'desktop' || answer === 'd') return 'desktop'
    throw new Error(`无法识别的选择：${answer}`)
  } finally {
    readline.close()
  }
}

/** Read commit charge and free physical memory; undefined when the probe is unavailable. */
function memorySnapshot(): MemorySnapshot | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', MEMORY_QUERY], { encoding: 'utf8' })
    return JSON.parse(raw) as MemorySnapshot
  } catch (error) {
    console.warn(`内存预检不可用（继续执行）：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Reasons the current commit headroom is too small for a build, empty when it is enough.
 * Free physical memory is informational: Windows pages the build out instead of failing.
 */
function memoryWarning(snapshot: MemorySnapshot): string[] {
  const reasons: string[] = []
  const headroom = snapshot.commitLimitGb - snapshot.commitUsedGb
  if (headroom < COMMIT_HEADROOM_FLOOR_GB) {
    const used = `${String(snapshot.commitUsedGb)}/${String(snapshot.commitLimitGb)} GB`
    reasons.push(`提交量余量 ${headroom.toFixed(1)} GB（已用 ${used}，建议余量 ≥ ${String(COMMIT_HEADROOM_FLOOR_GB)} GB）`)
  }
  return reasons
}

function printMemoryAdvice(): void {
  console.log('  处置建议：')
  console.log('   1) 关闭暂时不用的重程序（编辑器、聊天工具、多余浏览器窗口、后台实例）')
  console.log('   2) 加大虚拟内存：设置 → 系统 → 关于 → 高级系统设置 → 高级 → 性能“设置” → 高级 → 虚拟内存“更改”')
  console.log('   3) 只想先跑起来：pnpm start <web|desktop> --skip-build（用现有产物启动，不构建）')
}

/** Report the memory snapshot, asking before a build whose failure mode is fatal. */
async function confirmLowMemory(): Promise<boolean> {
  const snapshot = memorySnapshot()
  if (snapshot === undefined) return true
  const reasons = memoryWarning(snapshot)
  const used = `${String(snapshot.commitUsedGb)}/${String(snapshot.commitLimitGb)} GB`
  const summary = `内存预检：可用物理 ${String(snapshot.freePhysicalGb)} GB，提交量 ${used}`
  if (reasons.length === 0) {
    console.log(`${summary}（充足）`)
    return true
  }
  console.log(`${summary}（偏低）`)
  reasons.forEach((reason) => { console.log(`  - ${reason}`) })
  printMemoryAdvice()
  if (!process.stdin.isTTY) {
    console.log('非交互环境：继续执行构建。')
    return true
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await readline.question('仍要继续构建？输入 y 回车继续，直接回车取消: ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    readline.close()
  }
}

function recordedStamp(): { head?: string; sourceCommit?: string } {
  try {
    return JSON.parse(readFileSync(join(repositoryRoot, STAMP_FILE), 'utf8')) as { head?: string; sourceCommit?: string }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** Commit that last touched the trees whose sources are compiled into the artifacts. */
function sourceCommit(): string {
  return gitLines(['log', '-1', '--format=%H', '--', ...SOURCE_ROOTS])[0] ?? 'unknown'
}

/** Reasons that make the recorded artifacts stale, empty when they are current. */
function stalenessReasons(surface: Surface): string[] {
  const reasons: string[] = []
  const missing = surface.artifacts.filter(artifact => !existsSync(join(repositoryRoot, artifact)))
  if (missing.length > 0) reasons.push(`构建产物缺失（${missing.join('、')}）`)
  const stamp = recordedStamp()
  const commit = sourceCommit()
  if (stamp.sourceCommit === undefined) reasons.push('没有构建记录')
  else if (stamp.sourceCommit !== commit) reasons.push('源码已更新（上游或你的改动）')
  const dirty = gitLines(['status', '--porcelain', '--', ...SOURCE_ROOTS])
  if (dirty.length > 0) reasons.push(`源码有未提交改动（${String(dirty.length)} 处）`)
  return reasons
}

function recordStamp(): void {
  const head = gitLines(['rev-parse', 'HEAD'])[0]
  const target = join(repositoryRoot, STAMP_FILE)
  mkdirSync(dirname(target), { recursive: true })
  const record = { sourceCommit: sourceCommit(), head, builtAt: new Date().toISOString() }
  writeFileSync(target, `${JSON.stringify(record, undefined, 2)}\n`)
}

function lockPath(): string {
  return join(repositoryRoot, BUILD_LOCK_FILE)
}

interface PackageManifest {
  readonly version?: unknown
  readonly dependencies?: unknown
}

interface ProfileStorageUpdate {
  readonly name: string
  readonly version: string
}

/** Read a JSON package manifest and reject malformed files before using package metadata. */
function packageManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: package manifest must be an object`)
  }
  return value as PackageManifest
}

/** Read a manifest's regular dependencies after checking its JSON type. */
function packageDependencies(manifest: PackageManifest, path: string): Record<string, unknown> {
  const dependencies = manifest.dependencies
  if (dependencies === undefined) return {}
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    throw new Error(`${path}: package dependencies must be an object`)
  }
  return dependencies as Record<string, unknown>
}

/** Resolve storage dependencies already declared by the user's Web profile to this checkout's versions. */
function profileStorageUpdates(): { profile: string; updates: ProfileStorageUpdate[] } | undefined {
  const profile = join(resolveDshHome(), 'profiles', 'web')
  const packageFile = join(profile, 'package.json')
  if (!existsSync(packageFile)) return undefined
  const dependencies = packageDependencies(packageManifest(packageFile), packageFile)
  const updates: ProfileStorageUpdate[] = []
  for (const item of WEB_PROFILE_STORAGE_PACKAGES) {
    const current = dependencies[item.name]
    if (typeof current !== 'string' || /^(?:file:|link:|git\+|https?:|npm:)/u.test(current)) continue
    const version = packageManifest(join(repositoryRoot, item.manifest)).version
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`${item.manifest}: package version is missing`)
    }
    if (current !== version) updates.push({ name: item.name, version })
  }
  return { profile, updates }
}

/** Remove storage overrides so a linked source package is not pinned to an unpublished registry version. */
function removeProfileStorageOverrides(source: string, names: readonly string[]): string {
  const targets = new Set(names)
  let inOverrides = false
  return source.split(/(?<=\n)/u).filter((line) => {
    const content = line.replace(/\r?\n$/u, '')
    if (!inOverrides) {
      inOverrides = /^overrides:\s*(?:#.*)?$/u.test(content)
      return true
    }
    if (content.length > 0 && !/^[ \t]/u.test(content)) {
      inOverrides = /^overrides:\s*(?:#.*)?$/u.test(content)
      return true
    }
    const colon = content.indexOf(':')
    if (colon < 0) return true
    const key = content.slice(0, colon).trim().replace(/^['"]|['"]$/gu, '')
    return !targets.has(key)
  }).join('')
}

/** Synchronize profile-pinned storage packages before Web boot; never start with a known version mismatch. */
async function syncWebProfileStorage(): Promise<boolean> {
  const plan = profileStorageUpdates()
  if (plan === undefined || plan.updates.length === 0) return true
  const packageFile = join(plan.profile, 'package.json')
  const lockFile = join(plan.profile, 'pnpm-lock.yaml')
  const workspaceFile = join(plan.profile, 'pnpm-workspace.yaml')
  const files = [packageFile, lockFile, workspaceFile]
  const before = new Map(files.map(path => [path, existsSync(path) ? readFileSync(path) : undefined]))
  console.log(`Web profile 存储包版本与当前源码不一致，正在改用仓库源码包：${plan.updates.map(item => `${item.name}@${item.version}`).join('、')}`)
  try {
    if (existsSync(workspaceFile)) {
      const source = readFileSync(workspaceFile, 'utf8')
      const updated = removeProfileStorageOverrides(source, plan.updates.map(item => item.name))
      if (updated !== source) writeFileSync(workspaceFile, updated)
    }
    const addArguments = plan.updates.map((update) => {
      const item = WEB_PROFILE_STORAGE_PACKAGES.find(candidate => candidate.name === update.name)
      if (item === undefined) throw new Error(`${update.name}: storage package mapping is missing`)
      const target = dirname(join(repositoryRoot, item.manifest)).split(sep).join('/')
      return `${update.name}@link:${target}`
    })
    const code = await runPnpmCommand(['dsh', 'plugin', '--profile', 'web', 'add', ...addArguments])
    if (code !== 0) throw new Error(`pnpm exited with code ${String(code)}`)
    const after = packageDependencies(packageManifest(packageFile), packageFile)
    const unresolved = plan.updates.filter((item) => {
      const spec = after[item.name]
      if (typeof spec !== 'string' || !spec.startsWith('link:')) return true
      const installed = join(plan.profile, 'node_modules', ...item.name.split('/'), 'package.json')
      return !existsSync(installed) || packageManifest(installed).version !== item.version
    })
    if (unresolved.length > 0) {
      throw new Error(`profile did not install ${unresolved.map(item => `${item.name}@${item.version}`).join(', ')}`)
    }
    return true
  } catch (error) {
    let rollbackFailure: unknown
    for (const [path, content] of before) {
      try {
        if (content === undefined) rmSync(path, { force: true })
        else writeFileSync(path, content)
      } catch (restoreError) {
        rollbackFailure ??= restoreError
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    const rollback = rollbackFailure === undefined
      ? 'profile manifests and lockfile were restored'
      : `profile file restoration also failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`
    console.error(`Web profile 存储包同步失败，已停止启动。${detail}；${rollback}。请检查网络与 profile 包管理状态后重试。`)
    return false
  }
}

/** Process id recorded in the build lock, undefined when no lock file exists. */
function lockHolder(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(), 'utf8').trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Take the build lock; returns the live holder's pid when another build owns it. */
function acquireBuildLock(): number | undefined {
  const holder = lockHolder()
  if (holder !== undefined && holder !== process.pid && processAlive(holder)) return holder
  mkdirSync(dirname(lockPath()), { recursive: true })
  writeFileSync(lockPath(), `${String(process.pid)}\n`)
  return undefined
}

function releaseBuildLock(): void {
  try {
    if (lockHolder() === process.pid) rmSync(lockPath(), { force: true })
  } catch (error) {
    console.warn(`释放构建锁失败（可忽略）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function spawnPnpm(args: readonly string[], capture: boolean): ChildProcess {
  const pnpmEntry = process.env.npm_execpath
  const stdio: StdioOptions = capture ? ['inherit', 'pipe', 'pipe'] : 'inherit'
  if (pnpmEntry === undefined || pnpmEntry === '') {
    return spawn('pnpm', [...args], { cwd: repositoryRoot, stdio, shell: process.platform === 'win32' })
  }
  return spawn(process.execPath, [pnpmEntry, ...args], { cwd: repositoryRoot, stdio })
}

/** End the whole child tree so a crashed build cannot keep holding memory. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    console.warn(`清理构建进程树时收到：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Delete stale package residue before the build, then relink dependencies when anything was removed.
 * The removal leaves `node_modules` entries pointing at the deleted paths, so the build would still
 * read the dead output until pnpm reinstalls.
 */
async function preparePackageDirectories(): Promise<void> {
  const report = removeStalePackageResidue(repositoryRoot)
  if (report.removed.length > 0) {
    console.log(`清理上游已删除包的残留目录 ${String(report.removed.length)} 个：${report.removed.join('、')}`)
    console.log('  重装依赖以刷新指向旧路径的链接…')
    const installCode = await runPnpmCommand(['install'])
    if (installCode !== 0) console.warn('  pnpm install 未成功；构建若报模块缺失，请手动执行 pnpm install。')
  }
  for (const skipped of report.skipped) {
    console.log(`  保留未跟踪的包目录（含 package.json 或非构建产物）：${skipped}`)
  }
}

/** Run the build, streaming its output while retaining a tail for OOM diagnosis. */
async function runBuild(): Promise<{ code: number; tail: string[] }> {
  await preparePackageDirectories()
  const child = spawnPnpm(['run', 'build'], true)
  const tail: string[] = []
  const collect = (chunk: Buffer, target: NodeJS.WriteStream): void => {
    target.write(chunk)
    for (const line of chunk.toString('utf8').split('\n')) {
      tail.push(line)
      while (tail.length > BUILD_TAIL_LINES) tail.shift()
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => { collect(chunk, process.stdout) })
  child.stderr?.on('data', (chunk: Buffer) => { collect(chunk, process.stderr) })
  const interrupt = (): void => {
    killProcessTree(child)
    process.exit(130)
  }
  process.once('SIGINT', interrupt)
  try {
    const code = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => {
        resolveExit(exitCode ?? (signal === null ? 1 : 0))
      })
    })
    if (code !== 0) killProcessTree(child)
    return { code, tail }
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}

/** Run one pnpm command in the foreground and resolve with its exit code. */
async function runPnpmCommand(args: readonly string[]): Promise<number> {
  const child = spawnPnpm(args, false)
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 0))
    })
  })
}

/** Run one pnpm-owned surface script in the foreground and resolve with its exit code. */
async function runSurface(script: string, forwarded: readonly string[]): Promise<number> {
  return await runPnpmCommand(['run', script, ...forwarded])
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const surfaceName = options.surface ?? (await chooseSurface())
  const surface = SURFACES[surfaceName]
  const reasons = options.skipBuild ? [] : stalenessReasons(surface)
  const needsBuild = options.forceBuild || reasons.length > 0
  const storageSync = surfaceName === 'web' ? profileStorageUpdates() : undefined
  const planned: string[] = []
  if (needsBuild) planned.push('pnpm run build')
  if (storageSync !== undefined && storageSync.updates.length > 0) {
    planned.push('同步 Web profile 存储包版本')
  }
  planned.push(`pnpm run ${surface.script}`)
  console.log('')
  console.log(`启动目标：${surface.label}（端口 ${String(surface.port)}）`)
  if (options.forceBuild) console.log('构建原因：--force-build')
  else if (reasons.length > 0) console.log(`构建原因：${reasons.join('；')}`)
  else if (options.skipBuild) console.log('构建：按 --skip-build 跳过')
  else console.log('构建：产物是最新的，跳过')
  const forwardedSuffix = options.forwarded.length > 0 ? ` ${options.forwarded.join(' ')}` : ''
  console.log(`将执行：${planned.join(' -> ')}${forwardedSuffix}`)
  if (options.dryRun) {
    if (needsBuild) await confirmLowMemory()
    console.log('--dry-run：只打印计划，不执行。')
    return
  }
  if (needsBuild) {
    if (!options.ignoreMemory && !await confirmLowMemory()) {
      console.log('已按你的选择取消构建。')
      process.exitCode = 1
      return
    }
    const holder = acquireBuildLock()
    if (holder !== undefined) {
      console.error(`另一个构建正在进行（PID ${String(holder)}）。等它结束，或用 --skip-build 直接启动。`)
      process.exitCode = 1
      return
    }
    try {
      const result = await runBuild()
      if (result.code !== 0) {
        const outOfMemory = result.code === OOM_EXIT_CODE || result.tail.some(line => OOM_SIGNATURE.test(line))
        if (outOfMemory) {
          console.error('')
          console.error('构建因内存不足失败（V8 无法分配内存），已清理残留构建进程。')
          printMemoryAdvice()
        } else {
          console.error(`构建失败（退出码 ${String(result.code)}），已停止启动。`)
        }
        process.exitCode = result.code
        return
      }
      recordStamp()
    } finally {
      releaseBuildLock()
    }
  }
  if (surfaceName === 'web' && !await syncWebProfileStorage()) {
    process.exitCode = 1
    return
  }
  console.log('')
  process.exitCode = await runSurface(surface.script, options.forwarded)
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
