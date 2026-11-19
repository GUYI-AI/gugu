import { memo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { OFFLINE_SESSION_SLOT_PREFIX, installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { readSessionpageHistory } from '@/lib/sessionpageHistoryBridge'
import { PeekSessionTimeline } from '@/components/session-watch/PeekSessionTimeline'
import { OfflineSessionInput } from './OfflineSessionInput'

installShellSlots()
const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * The desktop task page of a session whose machine is offline and whose folder has not mounted here: the page draws its own
 * tab strip (the machine's offline status); this draws its body in the shell's tree (the conversation needs the shell's
 * Devices/Chat/Auth contexts) — the cached record and the queued input box, ❌ the phone page's header. A host whose
 * directory row has no native record gets the plain queued input.
 */
export const OfflineSessionSlotHost = memo(function OfflineSessionSlotHost() {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    listener => slots?.subscribeSlots(listener) ?? (() => {}),
    () => slots?.getSlots() ?? EMPTY,
  )
  return <>{[...entries].flatMap(([key, element]) => {
    if (!key.startsWith(OFFLINE_SESSION_SLOT_PREFIX)) return []
    const [sessionId, deviceId] = key.slice(OFFLINE_SESSION_SLOT_PREFIX.length).split('/').map(decodeURIComponent)
    const label = slots?.getSlotLabel?.(key) ?? ''
    return [createPortal(<div className="ta-skin flex h-full min-h-0 w-full flex-col">
      <PeekSessionTimeline sessionId={sessionId} deviceId={deviceId} nativeOnly embedded
        fallback={<OfflineSessionInput deviceId={deviceId} sessionId={sessionId} label={label} />}
        onBack={() => readSessionpageHistory()?.back()} />
    </div>, element, key)]
  })}</>
})
