import { useEffect, useId, useMemo, type ReactNode } from 'react'
import { useConversationVisibility } from '@/components/chat/useConversationVisibility'
import { messageForUser } from '@/lib/userFacingError'
import { notify } from '@/lib/notices'
import { deviceLiveWindowTransport } from '@/session/renderer/features/live-window/device-transport'
import { useLiveWindowConversation } from '@/session/renderer/features/live-window/use-live-window-conversation'
import { PhoneWatchWindow } from './PhoneWatchWindow'
import type { LiveWindowConversation } from '@/session/renderer/features/live-window/conversation'

function usePhoneSurfaceVisibility(conversation: LiveWindowConversation | undefined, shown: boolean) {
  const holder = useId()
  useEffect(() => { conversation?.setVisible(holder, shown); return () => conversation?.setVisible(holder, false) }, [conversation, holder, shown])
}

/** The page owns the header and picture, which consume this same account-bound conversation. */
export function PhoneLiveWindowConversation(props: {
  enabled: boolean; deviceId: string; sessionId: string; conversationId: string | undefined; agentId: string | undefined
  operating: boolean; connected: boolean
  children(live: PhoneLiveWindowBinding | null): ReactNode
}) {
  if (!props.enabled || !props.agentId || !props.conversationId) return props.children(null)
  return <ConnectedPhoneLiveWindow {...props} agentId={props.agentId} conversationId={props.conversationId} />
}

type PhoneLiveWindowBinding = ReturnType<typeof useLiveWindowConversation>
function ConnectedPhoneLiveWindow({ deviceId, sessionId, conversationId, agentId, operating, connected, children }: {
  deviceId: string; sessionId: string; conversationId: string; agentId: string; operating: boolean; connected: boolean
  children(live: PhoneLiveWindowBinding): ReactNode
}) {
  const context = useMemo(() => ({ conversationId, deviceId, sessionId, agentId, privateAgentChat: true, shown: false }),
    [conversationId, deviceId, sessionId, agentId])
  const transport = useMemo(() => deviceLiveWindowTransport(deviceId), [deviceId])
  const live = useLiveWindowConversation({ context, platform: 'phone', operating, connected, transport })
  return children(live)
}

/** Only the private conversation body holds picture visibility; group/topic pages do not mount it. */
export function PhoneLiveWindowSurface({ live, children }: { live: PhoneLiveWindowBinding | null; children: ReactNode }) {
  const visibility = useConversationVisibility(live !== null)
  const bound = live?.conversation
  // This body is retained across chat switches, so real intersection is authoritative.
  usePhoneSurfaceVisibility(bound, visibility.shown)
  if (!live) return children
  return <div ref={visibility.ref} data-phone-live-conversation className="relative flex min-h-0 flex-1 flex-col">
    {live.presentation ? <PhoneWatchWindow sources={live.sources} selectedId={live.source?.id ?? null} presentation={live.presentation}
      visible={live.visible} connected={live.connected} dispatch={live.dispatch} onError={error => notify({ key: `live-window:${live.context?.deviceId}:${live.context?.sessionId}`, tier: 'error', description: messageForUser(error) })}>
      {children}
    </PhoneWatchWindow> : children}
  </div>
}
