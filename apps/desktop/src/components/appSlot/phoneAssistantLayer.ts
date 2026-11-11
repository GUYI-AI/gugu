import type { AppAssistantCounts, AppAssistantStatus } from '../../session/shared/extensions/assistant-binding'
import type { PhoneAssistantScreen, PhoneSurfaceSection } from '../../session/shared/extensions/phone-binding'
import type { AppSurfaceIntent } from '../../session/shared/extensions/unread-binding'
import type { PushedWorkLedger } from '../../session/shared/extensions/work-binding'

/**
 * The phone's assistant layer as the App host sees it (API 49): which App page it shows now and in which section, what the
 * layer does when that page asks (move to a section, open one of the phone's own screens), and the assistant as the layer
 * knows it. Written only by the layer (MobileAssistantApp / MobileAssistantTab), the trusted shell; read by the binding host
 * (phoneAppBindings.ts), which believes it only for the conversation the binding reaches, checked again on every answer.
 * Nothing here is an App's to write.
 */
/** `hostPage`: one of the phone's own screens is drawn over the App's page now (`gugu.assistant.open`, its settings, …). */
export type PhoneLayerShown = { ownerId: string; extensionId: string; tabId: string; section: PhoneSurfaceSection; hostPage: boolean }
export type PhoneLayerActions = {
  move(section: PhoneSurfaceSection): void
  open(screen: PhoneAssistantScreen): void
  /** The layer's own assistant renamed as 自定义 saves a name (refused for any other agent). */
  rename(agentId: string, name: string): Promise<void>
  /** The task's own conversation, drawn by the layer over the 任务 section (its back closes it); null closes it. */
  openWork(work: { workId: string; sessionId: string } | null): void
  /** API 50 `removeVoiceNote`: the layer's own question before a voice note goes (删除“…”？); true = the person said yes. */
  confirmRemoval(question: { kind: 'voice-note'; title: string | null }): Promise<boolean>
}
export type PhoneLayerStatus = { ownerId: string; status: AppAssistantStatus }

let shown: PhoneLayerShown | null = null
let actions: PhoneLayerActions | null = null
let status: PhoneLayerStatus | null = null
/** The 资料 rows' numbers, read by the layer (PhoneAssistantCounts.tsx) while the App is its page. */
let counts: { ownerId: string; counts: AppAssistantCounts } | null = null
/** The assistant's work list as the layer's own 任务 list reads it (API 46), and the task whose conversation it draws now. */
let work: PushedWorkLedger | null = null
let openWork: { ownerId: string; workId: string; sessionId: string } | null = null
const workListeners = new Set<() => void>()
const shownListeners = new Set<() => void>()
const statusListeners = new Set<() => void>()
const intentListeners = new Set<(intent: AppSurfaceIntent) => void>()

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const phoneAssistantLayer = {
  shown: (): PhoneLayerShown | null => shown,
  /** The layer shows this App page in this section now; null: it shows none (closed, on the conversation, another account). */
  report(next: PhoneLayerShown | null): void {
    if (same(shown, next)) return
    shown = next
    for (const listener of shownListeners) listener()
  },
  onShown(listener: () => void): () => void {
    shownListeners.add(listener)
    return () => { shownListeners.delete(listener) }
  },
  actions: (): PhoneLayerActions | null => actions,
  /** While the layer is up: what it does for the page it shows. Returns the release (only its own). */
  provide(next: PhoneLayerActions): () => void {
    actions = next
    return () => { if (actions === next) actions = null }
  },
  /** The assistant as the layer knows it, with the 资料 numbers once the layer read them for that account (else null). */
  status: (): PhoneLayerStatus | null => (status && status.status.assistant === 'found' && counts?.ownerId === status.ownerId
    ? { ownerId: status.ownerId, status: { ...status.status, counts: counts.counts } } : status),
  publishStatus(next: PhoneLayerStatus | null): void {
    if (same(status, next)) return
    status = next
    for (const listener of statusListeners) listener()
  },
  publishCounts(next: { ownerId: string; counts: AppAssistantCounts } | null): void {
    if (same(counts, next)) return
    counts = next
    for (const listener of statusListeners) listener()
  },
  onStatus(listener: () => void): () => void {
    statusListeners.add(listener)
    return () => { statusListeners.delete(listener) }
  },
  /**
   * What the person asked of the App's page through the layer (`AppSurfaceIntent`): the recording bar's note opened
   * (`voice-note`), the assistant's 自定义 card (`profile`). Told once, after the layer moved to the section that shows it.
   */
  tell(intent: AppSurfaceIntent): void {
    for (const listener of intentListeners) listener(intent)
  },
  onIntent(listener: (intent: AppSurfaceIntent) => void): () => void {
    intentListeners.add(listener)
    return () => { intentListeners.delete(listener) }
  },
  work: (): PushedWorkLedger | null => work,
  openWork: (): { ownerId: string; workId: string; sessionId: string } | null => openWork,
  publishWork(next: PushedWorkLedger | null, open: { ownerId: string; workId: string; sessionId: string } | null): void {
    if (same([work, openWork], [next, open])) return
    work = next
    openWork = open
    for (const listener of workListeners) listener()
  },
  onWork(listener: () => void): () => void {
    workListeners.add(listener)
    return () => { workListeners.delete(listener) }
  },
}

/** Tests only. */
export function resetPhoneAssistantLayerForTest(): void {
  shown = null
  actions = null
  status = null
  counts = null
  work = null
  openWork = null
  shownListeners.clear()
  statusListeners.clear()
  workListeners.clear()
  intentListeners.clear()
}
