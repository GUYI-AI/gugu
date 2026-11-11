import type { ReactNode } from 'react'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from '../Avatar'
import { PaneHeader } from '../ui/Pane'
import { IconButton } from '../ui/IconButton'
import { ChevronLeft } from '../../lib/icons'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { useMobileShell } from '../../hooks/useMobileShell'
import { useDevicesStore } from '../../store/devicesContext'
import type { TaskChatEndpoint } from '../../lib/assistantTaskChat'
import { PeekSessionTimeline } from '../../mobile/agent-watch/PeekSessionTimeline'
import { TaskChatFilePreviewHost } from './TaskChatFilePreviewHost'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'
import './assistant-task-chat.css'

/**
 * The task pane's own conversation, alongside the personal assistant: the task's session, as its task page shows it.
 *
 * `appPanel` (owner 11-12, over an App's panel): it reads as part of that panel — the panel's surface shows through, its
 * header is the panel's top row, the composer is the assistant chat's (no view switcher, no model or permission controls).
 */
export function AssistantTaskChatWindow({ agent, task, onClose, status, pendingContent, appPanel = false }: {
  agent: Pick<ContactUser, 'id' | 'display_name' | 'avatar'>
  task: TaskChatEndpoint
  onClose: () => void
  status?: ReactNode
  pendingContent?: ReactNode
  appPanel?: boolean
}) {
  const { t } = useTranslation('assistant')
  const mobile = useMobileShell()
  const { devices } = useDevicesStore()
  const identity = useAvatarIdentity(agent.id)
  const name = useShownAgentName({ name: agent.display_name, createdAt: identity?.created_at ?? undefined })
  // The same test as the assistant's progress footnote (AssistantConversationProgress): this computer reads over IPC.
  const local = devices.some(device => device.device_id === task.deviceId && device.is_current_device)
  // D12: the task as the left column shows it (cleanedRecord), not the provider's raw record from the bounded window.
  return (
    <section className="assistant-task-chat-window ta-skin" aria-label={name} data-testid="assistant-task-chat-window" data-app-panel={appPanel || undefined}>
      <TaskChatFilePreviewHost mobile={mobile}>
        <PeekSessionTimeline sessionId={task.sessionId} deviceId={task.deviceId} local={local} cleanedRecord appPanel={appPanel} onBack={onClose} fallback={<>
          <PaneHeader title={name} subtitle={status} mobile={mobile} divider
            leading={<><IconButton aria-label={t('panel.back')} onClick={onClose} data-testid="assistant-task-chat-close"><ChevronLeft /></IconButton><Avatar name={name} seed={agent.id} avatarUrl={agent.avatar} size="sm" isAgent still harnessBadge={false} /></>} />
          {pendingContent ?? <div className="assistant-task-chat-window__pending"><LoadingIndicator size="panel" ariaLabel={t('chat.opening', { name })} /></div>}
        </>} />
      </TaskChatFilePreviewHost>
    </section>
  )
}
