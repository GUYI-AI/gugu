import type { SessionPatch } from '@gugu/session-core/acp'
import { changedFilePaths, projectToolContent } from '@gugu/session-core/acp'
import type { ChatDiff, ChatItem, FileChangeSummaryItem } from '@session-chat/model'
import { patchStats } from '@session-chat/components/rows/tools/diff/diff-lines'
import type { RecordedFileChange } from '@session-chat/commands'

/** Only acknowledged edits count. The patch bytes are a view of canonical content. */
export function successfulFileDiff(item: ChatItem): ChatDiff | null {
  if (('parentToolCallId' in item && item.parentToolCallId) || ('parentId' in item && item.parentId)) return null
  if (!('status' in item) || item.status !== 'done' || ('awaitingPermission' in item && item.awaitingPermission)) return null
  if (item.kind === 'diff') return item
  return item.kind === 'patch-tool-call' ? { kind: 'diff', id: item.id, patches: projectToolContent(item.contentBlocks ?? []).diffs, status: 'done' } : null
}

function total(patches: readonly SessionPatch[]): { adds: number | null; dels: number | null } {
  let adds = 0; let dels = 0
  for (const patch of patches) {
    const stats = patchStats(patch)
    if (!stats) return { adds: null, dels: null }
    adds += stats.adds; dels += stats.dels
  }
  return { adds, dels }
}

/** Counts are the observed patch operations, never a guessed task-wide file baseline. */
export function fileChangeSummary(turns: readonly { items: readonly ChatItem[] }[], turnId: string): FileChangeSummaryItem | null {
  const byPath = new Map<string, ChatDiff[]>()
  const patches: SessionPatch[] = []
  for (const turn of turns) for (const item of turn.items) {
    const diff = successfulFileDiff(item)
    if (!diff) continue
    patches.push(...diff.patches)
    for (const path of changedFilePaths(diff.patches)) {
      const files = byPath.get(path) ?? []
      files.push(diff); byPath.set(path, files)
    }
  }
  const files = [...byPath].map(([path, diffs]) => {
    const relevant = fileChangePatches(path, diffs)
    // A multi-file patch does not locate its textual totals per structured path.
    const stats = relevant.some(patch => patch.changes.length !== 1) ? { adds: null, dels: null } : total(relevant)
    return { path, diffs, ...stats }
  })
  return files.length ? { kind: 'file-change-summary', id: `${turnId}:file-changes`, turnId, files, ...total(patches) } : null
}

export function fileChangePatches(path: string, diffs: readonly ChatDiff[]): SessionPatch[] {
  return diffs.flatMap(diff => diff.patches.filter(patch => changedFilePaths([patch]).includes(path)))
}

/**
 * The one answer to "is this file already on the Edited card": an output the card already lists is not drawn twice.
 * A harness may name a patch's file relative to the working copy; an output's path is always absolute.
 */
export function isListedInSummary(summary: FileChangeSummaryItem | null, path: string): boolean {
  if (!summary) return false
  const target = path.replaceAll('\\', '/')
  return summary.files.some(file => {
    const listed = file.path.replaceAll('\\', '/')
    return listed === target || (!/^(\/|[A-Za-z]:\/)/.test(listed) && target.endsWith(`/${listed}`))
  })
}

/** One file across a whole session: every turn's Edited-card patches for it, oldest first, under the latest turn that touched it. */
export type SessionFileChange = RecordedFileChange & { adds: number | null; dels: number | null }

/** The Edited cards of these turns folded per file, most recently edited first. Same source as the card; nothing else is read. */
export function sessionFileChanges(turns: readonly { id: string; items: readonly ChatItem[] }[]): SessionFileChange[] {
  const byPath = new Map<string, SessionFileChange>()
  const add = (a: number | null | undefined, b: number | null) => a === undefined ? b : a === null || b === null ? null : a + b
  for (const turn of turns) for (const file of fileChangeSummary([turn], turn.id)?.files ?? []) {
    const prior = byPath.get(file.path)
    byPath.delete(file.path)
    byPath.set(file.path, { turnId: turn.id, path: file.path, patches: [...(prior?.patches ?? []), ...fileChangePatches(file.path, file.diffs)],
      adds: add(prior?.adds, file.adds), dels: add(prior?.dels, file.dels) })
  }
  return [...byPath.values()].reverse()
}
