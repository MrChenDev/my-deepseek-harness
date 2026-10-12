/** Build repository artifacts and bind client outputs to their public environment. */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CLIENT_BUILD_RECORD_PATH,
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Run one package-manager command with the selected public build environment. */
function runCommand(args: readonly string[], environment: NodeJS.ProcessEnv, label: string): void {
  const invocation = pnpmInvocation(args, environment)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: resolve(import.meta.dirname, '..'),
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`build: ${label} exited with ${String(result.status ?? result.signal)}`)
  }
}

/** Run one package script through the package manager that invoked this build. */
function runScript(script: string, environment: NodeJS.ProcessEnv): void {
  runCommand(['run', script], environment, script)
}

/** Names that hold nothing but output a build or an install writes inside a workspace package. */
const STALE_PACKAGE_RESIDUE = new Set(['lib', 'node_modules', '.typecheck', 'types', 'dist'])

/** Paths git tracks under one repository directory, empty when git cannot report them. */
function trackedPaths(root: string, directory: string): readonly string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--', directory], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split('\0').filter(path => path.length > 0)
}

/** Delete one directory tree without following the symlinks pnpm installs point at other packages. */
function removeResidueTree(target: string): void {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name)
    if (lstatSync(child).isSymbolicLink()) {
      unlinkSync(child)
      continue
    }
    if (entry.isDirectory()) removeResidueTree(child)
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Delete build output left behind in `packages/<group>/<package>` directories that git does not track
 * and that carry no manifest. A package an upstream merge deleted keeps its former `lib/` here, and the
 * bundler then compiles that dead output against the current sources.
 * @param root Repository root that owns `packages`.
 * @returns Removed and skipped directories, relative to `root`.
 */
export function removeStalePackageResidue(root: string): { removed: readonly string[]; skipped: readonly string[] } {
  const packageRoot = join(root, 'packages')
  if (!existsSync(packageRoot)) return { removed: [], skipped: [] }
  const tracked = trackedPaths(root, 'packages')
  const removed: string[] = []
  const skipped: string[] = []
  for (const group of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDirectory = join(packageRoot, group.name)
    for (const entry of readdirSync(groupDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relative = `packages/${group.name}/${entry.name}`
      if (tracked.some(path => path.startsWith(`${relative}/`))) continue
      const directory = join(groupDirectory, entry.name)
      const entries = readdirSync(directory)
      const onlyResidue = entries.every(name => STALE_PACKAGE_RESIDUE.has(name))
      const buildOutput = entries.includes('lib') || entries.includes('node_modules')
      if (entries.includes('package.json') || (!onlyResidue && !buildOutput)) {
        skipped.push(relative)
        continue
      }
      removeResidueTree(directory)
      removed.push(relative)
    }
  }
  return { removed, skipped }
}

/** Build client artifacts and optionally omit the repository test and script typechecks. */
function main(): void {
  // tsdown.config.ts loads only through Node type stripping (`--config-loader native`); this names the cause before tsdown fails.
  if (!process.features.typescript) {
    throw new Error('build: Node.js TypeScript type stripping is unavailable in this Node.js process; remove --no-experimental-strip-types from NODE_OPTIONS or use a Node.js build with TypeScript support')
  }
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      'artifacts-only': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const root = resolve(import.meta.dirname, '..')
  const repositoryEnvironment = repositoryClientBuildEnvironment(root, process.env)
  const profile = values.profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR]
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile)
  const buildEnvironment = clientBuildProcessEnvironment(process.env, clientEnvironment)

  const residue = removeStalePackageResidue(root)
  if (residue.removed.length > 0) {
    console.log(`build: removed stale package residue: ${residue.removed.join(', ')}`)
    console.log('build: run pnpm install when dependency links still point at those paths')
  }
  for (const skipped of residue.skipped) console.log(`build: left untracked package directory in place: ${skipped}`)

  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  runScript('build:native-system', buildEnvironment)
  if (values['artifacts-only']) {
    runCommand(['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'libraries'], buildEnvironment, 'artifact libraries')
  } else {
    runScript('build:lib', buildEnvironment)
  }
  runScript('build:web', buildEnvironment)
  const record = writeClientBuildRecord(root, clientEnvironment)
  console.log(
    `build: recorded ${String(record.artifacts.fileCount)} client artifact(s) with ${String(Object.keys(record.environment).length)} public value(s)`,
  )
}

if (import.meta.main) main()
