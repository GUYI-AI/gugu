import { useMemo, type ReactNode } from 'react'
import { useConversationVisibility } from '@/components/chat/useConversationVisibility'
import { messageForUser } from '@/lib/userFacingError'
import { notify } from '@/lib/notices'
import { deviceLiveWindowTransport } from '@/session/renderer/features/live-window/device-transport'
import { useLiveWindowConversation } from '@/session/renderer/features/live-window/use-live-window-conversation'
import { PhoneWatchWindow } from './PhoneWatchWindow'

/** Only a host-bound agent private conversation has a watching window. Group transcripts do not mount it. */
export function PhoneLiveWindowConversation(props: {
  enabled: boolean
  deviceId: string
  sessionId: string
  conversationId: string | undefined
  agentId: string | undefined
  operating: boolean
  children: ReactNode
}) {
  if (!props.enabled || !props.agentId || !props.conversationId) return props.children
  return <ConnectedPhoneLiveWindow {...props} agentId={props.agentId} conversationId={props.conversationId} />
}

function ConnectedPhoneLiveWindow({ deviceId, sessionId, conversationId, agentId, operating, children }: {
  deviceId: string; sessionId: string; conversationId: string; agentId: string; operating: boolean; children: ReactNode
}) {
  const visibility = useConversationVisibility(true)
  const context = useMemo(() => ({ conversationId, deviceId, sessionId, agentId, privateAgentChat: true, shown: visibility.shown }),
    [conversationId, deviceId, sessionId, agentId, visibility.shown])
  const transport = useMemo(() => deviceLiveWindowTransport(deviceId), [deviceId])
  const live = useLiveWindowConversation({ context, platform: 'phone', operating, transport })
  return <div ref={visibility.ref} data-phone-live-conversation className="relative flex min-h-0 flex-1 flex-col">
    {live.presentation ? <PhoneWatchWindow sources={live.sources} selectedId={live.source?.id ?? null} presentation={live.presentation}
      visible={live.visible} dispatch={live.dispatch} onError={error => notify({ key: `live-window:${deviceId}:${sessionId}`, tier: 'error', description: messageForUser(error) })}>
      {children}
    </PhoneWatchWindow> : children}
  </div>
}
