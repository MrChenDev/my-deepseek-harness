/**
 * Delete build output an upstream merge leaves behind in the package directories it removed.
 *
 * A merge that deletes `packages/<group>/<package>` removes only the tracked files, so the package's
 * former `lib/` and `node_modules/` stay on disk. pnpm keeps resolving that dead output, and a package
 * whose sources no longer match the current exports fails the bundler with a missing-export error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Names that hold nothing but output a build or an install writes inside a workspace package. */
const STALE_PACKAGE_RESIDUE = new Set(['lib', 'node_modules', '.typecheck', 'types', 'dist'])

/** Paths git tracks under one repository directory, empty when git cannot report them. */
function trackedPaths(root: string, directory: string): readonly string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--', directory], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split('\0').filter(path => path.length > 0)
}

/** Delete one directory tree without following the symlinks pnpm installs to point at other packages. */
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

/** Directories one cleanup pass deleted and left in place, relative to the repository root. */
export interface StalePackageResidueReport {
  /** Untracked package directories that held only build output and were deleted. */
  readonly removed: readonly string[]
  /** Untracked package directories a manifest or unrelated files own, left untouched. */
  readonly skipped: readonly string[]
}

/**
 * Delete untracked, manifest-free `packages/<group>/<package>` directories that hold only build output.
 * @param root Repository root that owns `packages`.
 * @returns The directories deleted and the directories left in place.
 */
export function removeStalePackageResidue(root: string): StalePackageResidueReport {
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
