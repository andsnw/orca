import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import {
  startAdaptiveGitCommonPoller,
  tryTakeGitCommonPollBaseline,
  type GitCommonPollingCadence
} from './worktree-git-common-poll-cadence'

// Shared with the darwin primary-metadata poll so platforms cannot drift.
// `logs/HEAD` catches head moves; `config.worktree` carries the sparse flag.
export const PRIMARY_CHECKOUT_METADATA_FILES = [
  'HEAD',
  'packed-refs',
  'index',
  'config.worktree',
  'logs/HEAD'
]
const LINKED_WORKTREE_STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
const LINKED_WORKTREE_INDEX_FILE = 'index'
const LINKED_WORKTREE_HEAD_LOG_FILE = join('logs', 'HEAD')

function statSignature(s: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function dirSignature(path: string): Promise<string> {
  try {
    // Why: keep `size` — on a coarse-timestamp filesystem a same-granule directory
    // allocation change would otherwise slip the readdir gate to the backstop.
    const s = await stat(path)
    return `${statSignature(s)}:${s.size}`
  } catch (error) {
    if (isMissingPathError(error)) {
      return 'missing'
    }
    throw error
  }
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? `${statSignature(s)}:${s.size}` : null
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

type GitCommonEntrySnapshot = {
  dirSignature: string
  structuralSignatures: Map<string, string>
  indexSignature: string | null
  headLogSignature: string | null
}

type GitCommonSnapshot = {
  worktreesDirSignature: string
  entries: Map<string, GitCommonEntrySnapshot>
  primarySignatures: Map<string, string>
  didFullScan: boolean
}

async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceFullScan: boolean
): Promise<GitCommonEntrySnapshot> {
  // Why: HEAD, gitdir, locked, config.worktree and logs/HEAD are rewritten in place without bumping
  // the entry-dir mtime, so — like the pre-idle-gate poller — they are re-stat'd EVERY tick, never
  // gated behind the dir signature (else a raw HEAD/structural rewrite would slip to the ~30s
  // backstop). Only `index` rides the entry-dir signature (its same-dir rewrites are index-backstop-bounded).
  const structuralSignatures = new Map<string, string>()
  const [nextDirSignature, headLogSignature] = await Promise.all([
    dirSignature(entryPath),
    fileSignature(join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE)),
    Promise.all(
      LINKED_WORKTREE_STRUCTURAL_METADATA_FILES.map(async (name) => {
        const signature = await fileSignature(join(entryPath, name))
        if (signature !== null) {
          structuralSignatures.set(name, signature)
        }
      })
    )
  ])
  if (nextDirSignature === 'missing') {
    // A transient stat failure must not masquerade as a removal; the parent listing is authoritative.
    return (
      previous ?? {
        dirSignature: nextDirSignature,
        structuralSignatures,
        indexSignature: null,
        headLogSignature
      }
    )
  }
  const shouldReadIndex = forceFullScan || !previous || previous.dirSignature !== nextDirSignature
  const indexSignature = shouldReadIndex
    ? await fileSignature(join(entryPath, LINKED_WORKTREE_INDEX_FILE))
    : previous.indexSignature
  return {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
}

async function snapshotPrimaryCheckoutSignatures(
  commonDirPath: string
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>()
  await Promise.all(
    PRIMARY_CHECKOUT_METADATA_FILES.map(async (name) => {
      const signature = await fileSignature(join(commonDirPath, name))
      if (signature !== null) {
        signatures.set(name, signature)
      }
    })
  )
  return signatures
}

async function snapshotGitCommon(
  commonDirPath: string,
  previous?: GitCommonSnapshot,
  includePrimary = true,
  forceFullScan = false
): Promise<GitCommonSnapshot> {
  const worktreesDir = join(commonDirPath, 'worktrees')
  const [worktreesDirSignature, primarySignatures] = await Promise.all([
    dirSignature(worktreesDir),
    includePrimary ? snapshotPrimaryCheckoutSignatures(commonDirPath) : new Map<string, string>()
  ])
  // Why: enumerate the worktrees dir EVERY tick rather than gating the readdir on its stat signature.
  // A single readdir of a small dir is negligible next to the per-entry structural stats that already
  // run each tick, and the signature gate could miss a same-granule add+remove on a coarse-mtime/FAT
  // filesystem (its size/mtime/ino/ctime all collide), leaving a linked worktree add/remove undetected
  // until the ~30s index backstop (#9882 review). The listing is the authoritative add/remove signal.
  let entryPaths: string[]
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    entryPaths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(worktreesDir, entry.name))
  } catch (error) {
    if (isMissingPathError(error)) {
      // Dir genuinely absent (no linked worktrees, or all removed) → authoritative empty listing.
      entryPaths = []
    } else {
      throw error
    }
  }

  const entries = new Map<string, GitCommonEntrySnapshot>()
  await Promise.all(
    entryPaths.map(async (entryPath) => {
      const previousEntry = previous?.entries.get(entryPath)
      entries.set(entryPath, await snapshotGitCommonEntry(entryPath, previousEntry, forceFullScan))
    })
  )
  // Why: the expensive per-entry `index` read stays gated on each entry's own dir signature; onFullScan
  // now reflects an ungated index-metadata backstop fan-out (forceFullScan) — the real periodic cost —
  // rather than the always-run worktrees-dir readdir.
  return {
    worktreesDirSignature,
    entries,
    primarySignatures,
    didFullScan: forceFullScan
  }
}

function classifySignatureDiff(
  prevSignature: string | null | undefined,
  nextSignature: string | null | undefined
): 'create' | 'update' | 'delete' | null {
  if (prevSignature == null && nextSignature == null) {
    return null
  }
  if (prevSignature == null) {
    return 'create'
  }
  if (nextSignature == null) {
    return 'delete'
  }
  return prevSignature === nextSignature ? null : 'update'
}

function diffSignatureMaps(
  prev: Map<string, string>,
  next: Map<string, string>,
  resolvePath: (name: string) => string
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const names = new Set([...prev.keys(), ...next.keys()])
  for (const name of names) {
    const type = classifySignatureDiff(prev.get(name), next.get(name))
    if (type) {
      events.push({ type, path: resolvePath(name) })
    }
  }
  return events
}

function diffGitCommon(
  commonDirPath: string,
  prev: GitCommonSnapshot,
  next: GitCommonSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const worktreesDir = join(commonDirPath, 'worktrees')
  const worktreesDirDiff = classifySignatureDiff(
    prev.worktreesDirSignature,
    next.worktreesDirSignature
  )
  if (worktreesDirDiff) {
    events.push({ type: worktreesDirDiff, path: worktreesDir })
  }
  for (const [entryPath, entry] of next.entries) {
    const prevEntry = prev.entries.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath })
      continue
    }
    events.push(
      ...diffSignatureMaps(prevEntry.structuralSignatures, entry.structuralSignatures, (name) =>
        join(entryPath, name)
      )
    )
    const indexDiff = classifySignatureDiff(prevEntry.indexSignature, entry.indexSignature)
    if (indexDiff) {
      events.push({ type: indexDiff, path: join(entryPath, LINKED_WORKTREE_INDEX_FILE) })
    }
    const headLogDiff = classifySignatureDiff(prevEntry.headLogSignature, entry.headLogSignature)
    if (headLogDiff) {
      events.push({ type: headLogDiff, path: join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE) })
    }
  }
  for (const entryPath of prev.entries.keys()) {
    if (!next.entries.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
    }
  }
  events.push(
    ...diffSignatureMaps(prev.primarySignatures, next.primarySignatures, (name) =>
      join(commonDirPath, name)
    )
  )
  return events
}

export async function startGitCommonPolling(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  cadence: GitCommonPollingCadence,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  includePrimary = true
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let snapshot = await tryTakeGitCommonPollBaseline(() =>
    snapshotGitCommon(commonDirPath, undefined, includePrimary)
  )
  const polling = startAdaptiveGitCommonPoller({
    cadence,
    visibility,
    poll: async (forceFullScan) => {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot ?? undefined,
        includePrimary,
        forceFullScan
      )
      if (disposed) {
        return { changed: false }
      }
      if (!snapshot) {
        snapshot = next
        onEvents([
          { type: 'update', path: join(commonDirPath, 'worktrees') },
          ...(includePrimary
            ? PRIMARY_CHECKOUT_METADATA_FILES.map((name) => ({
                type: 'update' as const,
                path: join(commonDirPath, name)
              }))
            : [])
        ])
        return { changed: true }
      }
      if (next.didFullScan) {
        onFullScan?.()
      }
      const events = diffGitCommon(commonDirPath, snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
      return { changed: events.length > 0 }
    }
  })

  return {
    unsubscribe: async () => {
      disposed = true
      await polling.unsubscribe()
    }
  }
}
