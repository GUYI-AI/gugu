import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { isNeedsYou } from '@gugu/core/shared/agentStatusPresentation'
import { useMobileShell } from '@/hooks/useMobileShell'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { followLink } from '@/lib/guguLinks'
import { readAssistantShellBridge } from '@/lib/assistantShellBridge'
import { Bell } from '@/lib/icons'
import { installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { setSidebarNotificationsOpen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { SectionLabel } from '../ui/SectionLabel'
import { rowKeyActivate } from '../contacts/contactsPanelStyles'
import { NOTIFICATION_LIST_SLOT_PREFIX, NOTIFICATION_TOGGLE_SLOT_PREFIX } from './NotificationSlot'
import { NeedsYouTaskRow } from './NeedsYouTaskRow'
import { isAssistantAgent } from '@/session/renderer/features/assistant/assistant-lineage'
import { markNeedsYouTaskSeen, useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'
import { usePasswordNotifications, usePasswordSnapshot, openPasswordRequest, openPasswordDevicePrompt } from '@/lib/passwordBetaNotifications'
import { promptedRequests, waitingToJoin } from '../password/passwordModel'

installShellSlots()
const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const unread = (task: NeedsYouTask) => isNeedsYou(sessionPresentation(task.session, true), task.session.unseen === true)

/** One account-owned notification list, shared by the desktop workspace and phone Messages header. */
export const NeedsYouHost = observer(function NeedsYouHost({ onAttentionChange }: { onAttentionChange?: (attention: AgentAttention) => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks, count, attention, error } = useNeedsYouTasks()
  const passwords = usePasswordNotifications()
  const sync = usePasswordSnapshot()?.sync
  const devices = promptedRequests(sync), joining = waitingToJoin(sync)
  const notificationCount = count + passwords.length + devices.length + (joining ? 1 : 0)
  const open = useSidebarNotificationsOpen()
  useEffect(() => { onAttentionChange?.(attention) }, [onAttentionChange, attention])
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  const [marking, setMarking] = useState(0)
  const [readError, setReadError] = useState<string | null>(null)
  useEffect(() => { setReadError(null) }, [open])
  const markRead = useCallback(async (items: NeedsYouTask[]) => {
    setMarking(count => count + 1)
    const results = await Promise.allSettled(items.map(markNeedsYouTaskSeen))
    const errors = results.flatMap(result => result.status === 'rejected' ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : [])
    if (errors.length) setReadError(previous => [previous, ...errors].filter(Boolean).join('\n'))
    setMarking(count => count - 1)
  }, [])
  // Opening the list reads nothing: a failure is read when its task is opened (the task view's read bit) or by Mark all read.
  const unreadFailures = tasks.filter(task => unread(task) && sessionPresentation(task.session, true)?.tone === 'error')
  const title = t('settings.general.notifications', { ns: 'main' })
  return <>{[...entries].map(([key, element]) => {
    if (key.startsWith(NOTIFICATION_TOGGLE_SLOT_PREFIX)) return createPortal(
      <span className="relative inline-flex">
        <IconButton size={mobile ? 'md' : 'sm'} aria-label={title} title={title} aria-pressed={open} on={open} data-testid="notification-toggle" onClick={() => setSidebarNotificationsOpen(!open)}>
          <Bell />
        </IconButton>
        {notificationCount > 0 && <Chip tone="danger" shape="count" className="pointer-events-none absolute -right-1 -top-1" data-testid="notification-count">{notificationCount > 99 ? '99+' : notificationCount}</Chip>}
      </span>, element, key)
    if (!key.startsWith(NOTIFICATION_LIST_SLOT_PREFIX) || !open || slots?.getSlotLabel?.(key) !== 'active') return null
    return createPortal(<>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
        <SectionLabel>{title}</SectionLabel>
        {unreadFailures.length > 0 && <Button size="sm" variant="ghost" data-testid="notification-mark-all-read" disabled={marking > 0} onClick={() => { void markRead(unreadFailures) }}>{t('chatList.markAllRead', { ns: 'messaging' })}</Button>}
      </div>
      <div data-testid="notification-list" data-notification-scroll="" role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {passwords.map(request => <Button key={request.requestId} variant="ghost" className="w-full justify-start" data-password-notification={request.requestId}
          onClick={() => { openPasswordRequest(request); setSidebarNotificationsOpen(false) }}>{request.kind === 'save' ? '请求保存密码' : '请求使用密码'} · {request.origin}</Button>)}
        {devices.map(request => <Button key={request.deviceId} variant="ghost" className="w-full justify-start" data-password-device={request.deviceId}
          onClick={() => { openPasswordDevicePrompt(request.deviceId); setSidebarNotificationsOpen(false) }}>「{request.label || '新设备'}」想用你的密码</Button>)}
        {joining && <Button variant="ghost" className="w-full justify-start" data-password-join=""
          onClick={() => { openPasswordDevicePrompt(null); setSidebarNotificationsOpen(false) }}>在另一台设备上允许这台电脑用你的密码</Button>}
        {tasks.map(task => {
          // The assistant's own session is the assistant, not a task of its: its row opens the assistant's chat, which the one
          // decision (lib/assistantEntry.ts) sends to its App, or, when the App is not usable here, opens as any chat — never the
          // task view, which has no place for it. The task view's read bit is not set by a chat, so this click sets it.
          // Read at the click: the list does not follow the assistant's snapshot.
          const openTask = () => {
            const assistant = readAssistantShellBridge()?.getSnapshot()
            if (!assistant?.chatId || !isAssistantAgent(task.session.agent?.userId, assistant.assistant?.id)) return followLink({ kind: 'session', sessionId: task.session.conversationId, deviceId: task.deviceId })
            void markRead([task])
            return followLink({ kind: 'chat', chatId: assistant.chatId })
          }
          return <NeedsYouTaskRow key={`${task.deviceId}/${task.session.conversationId}`} task={task} mobile={mobile} emphasis={unread(task)} onClick={openTask} onKeyDown={rowKeyActivate(openTask)} />
        })}
      </div>
    </>, element, key)
  })}</>
})
