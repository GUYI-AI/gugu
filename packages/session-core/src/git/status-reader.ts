import path from 'node:path'
import type { BoundExec } from '../exec'
import { gitErrorMessage } from './errors'
import { countFileLines } from './file-line-count'
import type { GitChange, GitStatusModel } from './models/status'
import { parseNumstat, type Numstat } from './parsers/numstat-parser'
import { mapGitChangeStatus } from './parsers/diff-parser'
import {
  MAX_STATUS_FILES,
  StatusParser,
  TooManyFilesChangedError,
  type FileStatus
} from './parsers/status-parser'

const MAX_DIFF_CONTENT_BYTES = 512 * 1024
export type GitStatusReader = (worktree: string, exec: BoundExec) => Promise<GitStatusModel>

export async function readGitStatus(
  worktree: string,
  exec: BoundExec,
  signal?: AbortSignal
): Promise<GitStatusModel> {
  try {
    const parser = new StatusParser()
    const [, stagedRes, unstagedRes] = await Promise.all([
      runStatusZ(exec, parser, signal),
      exec.exec(['diff', '--numstat', '--cached'], { signal }).catch(() => ({ stdout: '' })),
      exec.exec(['diff', '--numstat'], { signal }).catch(() => ({ stdout: '' }))
    ])

    if (parser.status.length > MAX_STATUS_FILES || parser.tooManyFiles) {
      return { kind: 'too-many-files' }
    }

    return await buildStatus(
      worktree,
      parser.status,
      parseNumstat(stagedRes.stdout),
      parseNumstat(unstagedRes.stdout),
      signal
    )
  } catch (error) {
    if (error instanceof TooManyFilesChangedError) return { kind: 'too-many-files' }
    return {
      kind: 'error',
      message: gitErrorMessage(error)
    }
  }
}

async function runStatusZ(
  exec: BoundExec,
  parser: StatusParser,
  signal?: AbortSignal
): Promise<void> {
  await exec.execStreaming(
    ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '-uall'],
    (chunk) => {
      parser.update(chunk)
      return !parser.tooManyFiles
    },
    { signal }
  )
  if (parser.tooManyFiles) throw new TooManyFilesChangedError()
}

async function buildStatus(
  worktree: string,
  entries: FileStatus[],
  stagedNumstat: Numstat,
  unstagedNumstat: Numstat,
  signal?: AbortSignal
): Promise<GitStatusModel> {
  const staged: GitChange[] = []
  const unstaged: GitChange[] = []

  for (const entry of entries) {
    signal?.throwIfAborted()
    const code = `${entry.x}${entry.y}`
    const filePath = entry.rename ?? entry.path
    const status = mapGitChangeStatus(code)

    if (entry.x !== ' ' && entry.x !== '?') {
      const stat = stagedNumstat.get(filePath)
      staged.push({
        path: toAbsolutePath(worktree, filePath),
        status,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        indexOid: entry.indexOid
      })
    }

    const isUntracked = code === '??'
    const hasUnstaged = entry.y !== ' ' && entry.y !== '?'
    if (!isUntracked && !hasUnstaged) continue

    let additions = unstagedNumstat.get(filePath)?.additions ?? 0
    const deletions = unstagedNumstat.get(filePath)?.deletions ?? 0
    if (additions === 0 && deletions === 0 && isUntracked) {
      try {
        const result = await countFileLines(toAbsolutePath(worktree, filePath), {
          maxBytes: MAX_DIFF_CONTENT_BYTES
        })
        if (!result.truncated) additions = result.lines
      } catch {}
    }

    unstaged.push({ path: toAbsolutePath(worktree, filePath), status, additions, deletions })
  }

  const stagedAdded = staged.reduce((sum, change) => sum + change.additions, 0)
  const stagedDeleted = staged.reduce((sum, change) => sum + change.deletions, 0)
  return {
    kind: 'ok',
    staged,
    unstaged,
    stagedAdded,
    stagedDeleted
  }
}

function toAbsolutePath(worktree: string, filePath: string): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return path.normalize(filePath)
  return path.join(worktree, filePath)
}
