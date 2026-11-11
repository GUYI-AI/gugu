// #1925 (API 46) The shell's half of the assistant's work list for Apps, apart from what it draws (AppWorkLedgerHost.tsx):
// which Apps read it, what of each built-in row goes to main, and the pushes to main.
import { agentNamingUntil } from '@gugu/core/shared/agentDefaultName'
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '@gugu/core/shared/agentStatus'
import type { AssistantPanelTask, AssistantWorkTasksRead } from '../assistant/assistant-panel-tasks'
import { rendererLogger } from '../../lib/log'
import { rpc } from '@/session/renderer/lib/ipc'
import type { ExtensionManifest } from '@/session/shared/extensions/manifest'
import { WORK_TITLE_MAX, type AppWorkStatus, type PushedWorkLedger, type PushedWorkRow } from '@/session/shared/extensions/work-binding'

const log = rendererLogger('app-work-ledger')

/** An App that reads the assistant's work (`permissions.bindings[0].actions` has `work`, #1925 API 46). */
export function readsWork(manifest: ExtensionManifest): boolean {
  return manifest.permissions?.bindings?.[0]?.actions.includes('work') ?? false
}

/** The indicator as the row draws it, and nothing else: a word the build does not know is no indicator, never a guess. */
function statusOf(status: AssistantPanelTask['status']): AppWorkStatus | null {
  if (!status || !(AGENT_STATUSES as readonly string[]).includes(status.status)) return null
  const detail = status.detail && (AGENT_STATUS_DETAILS as readonly string[]).includes(status.detail) ? status.detail : null
  return { status: status.status, detail }
}

/**
 * The built-in list's rows (assistant-tasks.tsx), as main keeps them for Apps: what each row draws — its title (and whether
 * "naming…" stands in for it, as `AssistantTaskName` decides), its indicator, its unseen dot, the time it is sorted and
 * grouped by — and the two ids `openWork` finds it by, which stay in main. `namingUntil`: when the first "naming…" ends.
 */
export function pushedRowsOf(tasks: readonly AssistantPanelTask[], createdAt: (agentId: string) => string | undefined, now: number): { rows: PushedWorkRow[]; namingUntil: number | null } {
  let namingUntil: number | null = null
  const rows = tasks.map((task): PushedWorkRow => {
    const until = agentNamingUntil(task.title, task.harness, task.agentId ? createdAt(task.agentId) : undefined, now)
    if (until !== null) namingUntil = namingUntil === null ? until : Math.min(namingUntil, until)
    return {
      workId: task.workId,
      sessionId: task.id,
      title: task.title.slice(0, WORK_TITLE_MAX),
      naming: until !== null,
      status: statusOf(task.status),
      unseen: task.unseen,
      updatedAt: task.lastInteractedAt,
    }
  })
  return { rows, namingUntil }
}

/** What the built-in list shows of its read: loading; the rows; the rows kept after a failed refresh; a failure with none. */
export function ledgerStateOf(read: AssistantWorkTasksRead): PushedWorkLedger['state'] {
  if (read.state === 'loading') return 'loading'
  if (read.state === 'error') return read.data.length > 0 ? 'stale' : 'failed'
  return 'ready'
}

/**
 * One push at a time in order; the same reading twice is pushed once — main starts with none, so a window where no App reads
 * work pushes nothing at all. A refused push is pushed again on the next change.
 */
export const NO_LEDGER: PushedWorkLedger = { ownerId: null, assistantId: null, state: 'none', rows: [] }
let lastPushed = JSON.stringify(NO_LEDGER)
export function pushLedger(ledger: PushedWorkLedger): void {
  const key = JSON.stringify(ledger)
  if (key === lastPushed) return
  lastPushed = key
  const forget = (error: unknown) => {
    if (lastPushed === key) lastPushed = ''
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'Apps could not be handed the work list')
  }
  void Promise.resolve().then(() => rpc.extensions.workLedgerChanged(ledger)).then((result) => { if (!result.success) forget(result.error) }, forget)
}

/** Tests only: a window that has pushed nothing yet. */
export function forgetPushedWorkForTest(): void {
  lastPushed = JSON.stringify(NO_LEDGER)
}
