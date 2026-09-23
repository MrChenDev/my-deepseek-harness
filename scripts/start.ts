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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

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

/** Headroom below these bounds risks the fatal zone allocation `tsc` reports. */
const FREE_PHYSICAL_FLOOR_GB = 4
const COMMIT_HEADROOM_FLOOR_GB = 8

/** Output tail retained for diagnosing a failed build. */
const BUILD_TAIL_LINES = 300

/** Exit status a Windows process reports after a fatal V8 allocation failure. */
const OOM_EXIT_CODE = 2147483651

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

/** Reasons the current memory headroom is too small for a build, empty when it is enough. */
function memoryWarning(snapshot: MemorySnapshot): string[] {
  const reasons: string[] = []
  if (snapshot.freePhysicalGb < FREE_PHYSICAL_FLOOR_GB) {
    reasons.push(`可用物理内存 ${String(snapshot.freePhysicalGb)} GB（建议 ≥ ${String(FREE_PHYSICAL_FLOOR_GB)} GB）`)
  }
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

function recordedStamp(): { head?: string } {
  try {
    return JSON.parse(readFileSync(join(repositoryRoot, STAMP_FILE), 'utf8')) as { head?: string }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** Reasons that make the recorded artifacts stale, empty when they are current. */
function stalenessReasons(surface: Surface): string[] {
  const reasons: string[] = []
  const missing = surface.artifacts.filter(artifact => !existsSync(join(repositoryRoot, artifact)))
  if (missing.length > 0) reasons.push(`构建产物缺失（${missing.join('、')}）`)
  const head = gitLines(['rev-parse', 'HEAD'])[0]
  const stamp = recordedStamp()
  if (stamp.head !== head) reasons.push(stamp.head === undefined ? '没有构建记录' : '检出提交已变化')
  const dirty = gitLines(['status', '--porcelain', '--', ...SOURCE_ROOTS])
  if (dirty.length > 0) reasons.push(`源码有未提交改动（${String(dirty.length)} 处）`)
  return reasons
}

function recordStamp(): void {
  const head = gitLines(['rev-parse', 'HEAD'])[0]
  const target = join(repositoryRoot, STAMP_FILE)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify({ head, builtAt: new Date().toISOString() }, undefined, 2)}\n`)
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

/** Run the build, streaming its output while retaining a tail for OOM diagnosis. */
async function runBuild(): Promise<{ code: number; tail: string[] }> {
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

/** Run one pnpm-owned command in the foreground and resolve with its exit code. */
async function runSurface(script: string, forwarded: readonly string[]): Promise<number> {
  const child = spawnPnpm(['run', script, ...forwarded], false)
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal === null ? 1 : 0))
    })
  })
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const surfaceName = options.surface ?? (await chooseSurface())
  const surface = SURFACES[surfaceName]
  const reasons = options.skipBuild ? [] : stalenessReasons(surface)
  const needsBuild = options.forceBuild || reasons.length > 0
  const planned: string[] = []
  if (needsBuild) planned.push('pnpm run build')
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
  }
  console.log('')
  process.exitCode = await runSurface(surface.script, options.forwarded)
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
