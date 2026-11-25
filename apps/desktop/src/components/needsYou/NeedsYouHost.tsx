import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { isNeedsYou } from '@gugu/core/shared/agentStatusPresentation'
import { useMobileShell } from '@/hooks/useMobileShell'
import { sessionPresentation } from '@/lib/agent-wait/watch-status'
import { followLink } from '@/lib/guguLinks'
import { readAssistantShellBridge } from '@/lib/assistantShellBridge'
import { Bell, ChevronLeft } from '@/lib/icons'
import { installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { setSidebarNotificationsOpen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { RefreshFailed } from '../ui/RefreshFailed'
import { IconButton } from '../ui/IconButton'
import { PaneEmptyState } from '../ui/PaneEmptyState'
import { Illustration } from '../ui/Illustration'
import { Hint } from '../ui/Tooltip'
import { Popover } from '../ui/Popover'
import { menuSurfaceClassName } from '../ui/Menu'
import { rowKeyActivate } from '../contacts/contactsPanelStyles'
import { NOTIFICATION_LIST_SLOT_PREFIX, NOTIFICATION_TOGGLE_SLOT_PREFIX } from './NotificationSlot'
import { NeedsYouTaskRow } from './NeedsYouTaskRow'
import { isAssistantAgent } from '@/session/renderer/features/assistant/assistant-lineage'
import { markNeedsYouTaskSeen, useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'
import { passwordNotifications, usePasswordVault, openPasswordRequest, openPasswordDevicePrompt } from '@/lib/passwordBetaNotifications'
import { promptedRequests } from '../password/passwordModel'
import { persistentNotices } from '@/lib/notices'
import { NoticeCard } from '../NoticeHost'

installShellSlots()
const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const unread = (task: NeedsYouTask) => isNeedsYou(sessionPresentation(task.session, true), task.session.unseen === true)

/** One account-owned notification list, shared by the desktop workspace and phone Messages header. */
export const NeedsYouHost = observer(function NeedsYouHost() {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks, count, error, loading } = useNeedsYouTasks()
  const vault = usePasswordVault()
  const passwords = passwordNotifications(vault.snapshot)
  const sync = vault.snapshot?.sync
  const devices = promptedRequests(sync)
  // 右上角那一叠卡里点了「以后再说」的常驻通知,收在这里;在这里清掉才算关掉(lib/notices)。
  const notices = useSyncExternalStore(persistentNotices.subscribe, persistentNotices.read, persistentNotices.read)
  const deferred = notices.filter(notice => notice.deferred)
  const notificationCount = count + passwords.length + devices.length + deferred.length
  const open = useSidebarNotificationsOpen()
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
  const showEmpty = !loading && !error && !readError && tasks.length === 0 && passwords.length === 0 && devices.length === 0 && deferred.length === 0
  // The list's head: the phone's says the way back to its chats (the list takes their place); the desktop's popover names
  // itself, and Esc, a click outside or the bell again close it.
  const list = (head: ReactNode) => <>
    <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
      {head}
      {unreadFailures.length > 0 && <Button size="sm" variant="ghost" data-testid="notification-mark-all-read" disabled={marking > 0} onClick={() => { void markRead(unreadFailures) }}>{t('chatList.markAllRead', { ns: 'messaging' })}</Button>}
    </div>
    {showEmpty ? <div className="grid min-h-0 flex-1 place-items-center px-4 pb-4" data-testid="notification-list">
      <PaneEmptyState art={<Illustration name="no-notifications" className={mobile ? 'w-[104px]' : 'w-[88px]'} />} caption={t('settings.general.notificationsEmpty.title', { ns: 'main' })} hint={t('settings.general.notificationsEmpty.hint', { ns: 'main' })} />
    </div> : <div data-testid="notification-list" data-notification-scroll="" role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-auto px-2 pb-4">
      {error && <p role="alert">{error}</p>}
      {readError && <p role="alert">{readError}</p>}
      <RefreshFailed error={vault.failure} onRetry={vault.retry} />
      {passwords.map(request => <Button key={request.requestId} variant="ghost" className="w-full justify-start" data-password-notification={request.requestId}
        onClick={() => { openPasswordRequest(request); setSidebarNotificationsOpen(false) }}>{t(request.kind === 'save' ? 'passwords.notifySave' : 'passwords.notifyUse', { ns: 'settings' })} : {request.origin}</Button>)}
      {devices.map(request => <Button key={request.deviceId} variant="ghost" className="w-full justify-start" data-password-device={request.deviceId}
        onClick={() => { openPasswordDevicePrompt(request.deviceId); setSidebarNotificationsOpen(false) }}>{t('passwords.notifyDevice', { ns: 'settings', name: request.label || t('passwords.newDevice', { ns: 'settings' }) })}</Button>)}
      {deferred.length > 0 && <div className="flex flex-col gap-2 px-2 pb-2" data-testid="notification-notices">
        {deferred.map(notice => <NoticeCard key={notice.key} notice={notice} onClear={() => persistentNotices.clear(notice.key)} />)}
      </div>}
      {tasks.map(task => {
        // The assistant's own session is the assistant, not a task of its: its row opens the assistant's chat, which the one
        // decision (lib/assistantEntry.ts) sends to its App, or, when the App is not usable here, opens as any chat — never the
        // task view, which has no place for it. The task view's read bit is not set by a chat, so this click sets it.
        // Read at the click: the list does not follow the assistant's snapshot. On the desktop the popover closes, as a menu does.
        const openTask = () => {
          if (!mobile) setSidebarNotificationsOpen(false)
          const failure = sessionPresentation(task.session, true)?.tone === 'error'
          if (failure) void markRead([task])
          const assistant = readAssistantShellBridge()?.getSnapshot()
          if (!assistant?.chatId || !isAssistantAgent(task.session.agent?.userId, assistant.assistant?.id)) return followLink({ kind: 'session', sessionId: task.session.conversationId, deviceId: task.deviceId })
          if (!failure) void markRead([task])
          return followLink({ kind: 'chat', chatId: assistant.chatId })
        }
        return <NeedsYouTaskRow key={`${task.deviceId}/${task.session.conversationId}`} task={task} mobile={mobile} emphasis={unread(task)} onClick={openTask} onKeyDown={rowKeyActivate(openTask)} />
      })}
    </div>}
  </>
  return <>{[...entries].map(([key, element]) => {
    // md: on the desktop sidebar's foot (#2548) the bell sits in one row with the 32px 已安排 and 会话历史 buttons, and in
    // the phone's chat list header beside its 32px 「+」; the phone grows md to the touch size (IconButton).
    // One bell at a time: a place may hold an inactive slot, as the phone list's slots do.
    const active = slots?.getSlotLabel?.(key) === 'active'
    if (key.startsWith(NOTIFICATION_TOGGLE_SLOT_PREFIX)) {
      if (!active) return null
      const bell = <IconButton size="md" tone={element.dataset.tone === 'strong' ? 'strong' : undefined} aria-label={title} aria-pressed={mobile ? open : undefined} on={open} data-testid="notification-toggle"
        onClick={mobile ? () => setSidebarNotificationsOpen(!open) : undefined}><Bell /></IconButton>
      // The desktop's list pops beside the bell, the app's popover like any other; the phone's takes the chat list's place.
      return createPortal(<span className="relative inline-flex">
        {mobile ? <Hint label={title} side="bottom">{bell}</Hint> : <Popover.Root open={open} onOpenChange={setSidebarNotificationsOpen}>
          <Hint label={title} side="bottom"><Popover.Trigger render={bell} /></Hint>
          <Popover.Portal><Popover.Positioner side="right" align="end" sideOffset={8} collisionPadding={8}>
            <Popover.Popup aria-label={title} data-testid="notification-popover" className={`${menuSurfaceClassName} flex max-h-[min(560px,80vh)] w-[360px] flex-col`}>
              {list(<Popover.Title className="m-0 text-[length:var(--font-body)] font-medium">{title}</Popover.Title>)}
            </Popover.Popup>
          </Popover.Positioner></Popover.Portal>
        </Popover.Root>}
        {notificationCount > 0 && <Chip tone="danger" shape="count" className="pointer-events-none absolute -right-1 -top-1" data-testid="notification-count">{notificationCount > 99 ? '99+' : notificationCount}</Chip>}
      </span>, element, key)
    }
    if (!key.startsWith(NOTIFICATION_LIST_SLOT_PREFIX) || !open || !active) return null
    return createPortal(list(
      <Button size="sm" variant="ghost" className="-ml-2 gap-1 font-medium text-[var(--fg)]" data-testid="notification-back"
        aria-label={t('chatArea.backToList', { ns: 'messaging' })} title={t('chatArea.backToList', { ns: 'messaging' })} onClick={() => setSidebarNotificationsOpen(false)}>
        <ChevronLeft className="size-4" />{t('shell.chats', { ns: 'main' })}
      </Button>), element, key)
  })}</>
})
