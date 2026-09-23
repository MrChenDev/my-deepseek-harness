/**
 * Interactive launcher for the two runnable surfaces of this workspace.
 *
 * `pnpm start` prints a Web/Desktop menu, builds when the artifacts are missing
 * or older than the checked-out commit or source edits, then hands the terminal
 * to the surface command so its own URL, port, and window output stay visible.
 * A surface can be named directly (`pnpm start web`) for scripted use, and
 * `--dry-run` prints the plan without building or launching anything.
 */

import { execFileSync, spawn } from 'node:child_process'
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

/** Build outputs recorded in the launch stamp after a successful build. */
const STAMP_FILE = '.dsh-build/start-stamp.json'

/** Source trees whose uncommitted edits make the built artifacts stale. */
const SOURCE_ROOTS = ['packages', 'apps', 'vendor', 'native'] as const

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

function gitLines(gitArguments: readonly string[]): string[] {
  const output = execFileSync('git', [...gitArguments], { cwd: repositoryRoot, encoding: 'utf8' })
  return output.split('\n').filter(line => line !== '')
}

function parseArguments(argv: readonly string[]): {
  surface: SurfaceName | undefined
  forceBuild: boolean
  skipBuild: boolean
  dryRun: boolean
  forwarded: string[]
} {
  let surface: SurfaceName | undefined
  const forwarded: string[] = []
  let forceBuild = false
  let skipBuild = false
  let dryRun = false
  for (const argument of argv) {
    if (argument === 'web' || argument === 'desktop') surface = argument
    else if (argument === '--force-build') forceBuild = true
    else if (argument === '--skip-build') skipBuild = true
    else if (argument === '--dry-run') dryRun = true
    else if (argument === '--') continue
    else forwarded.push(argument)
  }
  return { surface, forceBuild, skipBuild, dryRun, forwarded }
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

/** Run one pnpm-owned command in the foreground and resolve with its exit code. */
async function runPnpm(args: readonly string[]): Promise<number> {
  const pnpmEntry = process.env.npm_execpath
  const child = pnpmEntry === undefined || pnpmEntry === ''
    ? spawn('pnpm', [...args], { cwd: repositoryRoot, stdio: 'inherit', shell: process.platform === 'win32' })
    : spawn(process.execPath, [pnpmEntry, ...args], { cwd: repositoryRoot, stdio: 'inherit' })
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
  const planned: string[] = []
  if (reasons.length > 0) planned.push('pnpm run build')
  planned.push(`pnpm run ${surface.script}`)
  console.log('')
  console.log(`启动目标：${surface.label}（端口 ${String(surface.port)}）`)
  if (options.forceBuild) console.log('构建原因：--force-build')
  else if (reasons.length > 0) console.log(`构建原因：${reasons.join('；')}`)
  else if (options.skipBuild) console.log('构建：按 --skip-build 跳过')
  else console.log('构建：产物是最新的，跳过')
  console.log(`将执行：${planned.join(' -> ')}${options.forwarded.length > 0 ? ` ${options.forwarded.join(' ')}` : ''}`)
  if (options.dryRun) {
    console.log('--dry-run：只打印计划，不执行。')
    return
  }
  if (options.forceBuild || reasons.length > 0) {
    const buildCode = await runPnpm(['run', 'build'])
    if (buildCode !== 0) {
      console.error(`构建失败（退出码 ${String(buildCode)}），已停止启动。`)
      process.exitCode = buildCode
      return
    }
    recordStamp()
  }
  console.log('')
  process.exitCode = await runPnpm(['run', surface.script, ...options.forwarded])
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
