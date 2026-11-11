import type { AppAssistantStatus } from '../../session/shared/extensions/assistant-binding'
import type { PhoneAssistantScreen, PhoneSurfaceSection } from '../../session/shared/extensions/phone-binding'

/**
 * The phone's assistant layer as the App host sees it (API 48): which App page it shows now and in which section, what the
 * layer does when that page asks (move to a section, open one of the phone's own screens), and the assistant as the layer
 * knows it. Written only by the layer (MobileAssistantApp / MobileAssistantTab), the trusted shell; read by the binding host
 * (phoneAppBindings.ts), which believes it only for the conversation the binding reaches, checked again on every answer.
 * Nothing here is an App's to write.
 */
export type PhoneLayerShown = { ownerId: string; extensionId: string; tabId: string; section: PhoneSurfaceSection }
export type PhoneLayerActions = { move(section: PhoneSurfaceSection): void; open(screen: PhoneAssistantScreen): void }
export type PhoneLayerStatus = { ownerId: string; status: AppAssistantStatus }

let shown: PhoneLayerShown | null = null
let actions: PhoneLayerActions | null = null
let status: PhoneLayerStatus | null = null
const shownListeners = new Set<() => void>()
const statusListeners = new Set<() => void>()

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
  status: (): PhoneLayerStatus | null => status,
  publishStatus(next: PhoneLayerStatus | null): void {
    if (same(status, next)) return
    status = next
    for (const listener of statusListeners) listener()
  },
  onStatus(listener: () => void): () => void {
    statusListeners.add(listener)
    return () => { statusListeners.delete(listener) }
  },
}

/** Tests only. */
export function resetPhoneAssistantLayerForTest(): void {
  shown = null
  actions = null
  status = null
  shownListeners.clear()
  statusListeners.clear()
}
