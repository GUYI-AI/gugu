import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../store/auth'
import { useTranslation } from 'react-i18next'
import { OPEN_ASSISTANT_TASK_CHAT, showAssistantTaskChat, useOpenedAssistantTaskChat, type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantSlotKey } from '../../lib/assistantShellBridge'
import { readShellSlots } from '../../lib/shellSlots'
import {AssistantWorkTaskWindow} from './AssistantWorkTaskWindow'

export function AssistantTaskChatOpener({ visible }: { visible: boolean }) {
  const { user } = useAuth()
  const { t } = useTranslation('assistant')
  const opened = useOpenedAssistantTaskChat()
  const shellSlots = readShellSlots()
  const slot = useSyncExternalStore((listener) => shellSlots?.subscribeSlots(listener) ?? (() => undefined), () => shellSlots?.getSlots().get(assistantSlotKey('task-chat')) ?? null)
  const wasVisible=useRef(visible)
  useEffect(() => {
    const left=wasVisible.current&&!visible
    wasVisible.current=visible
    if(left||opened&&opened.ownerId!==user?.id)showAssistantTaskChat(null)
  }, [visible, user?.id, opened])
  useEffect(() => {
    if (!user) return
    const open = (event: Event) => {
      const request = (event as CustomEvent<AssistantTaskChat>).detail
      showAssistantTaskChat({ ownerId: user.id, request, name: request.title ?? t('tasks.title') })
    }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, open)
    return () => window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, open)
  }, [t, user])
  if(!visible||!slot)return null
  if(!opened||user?.id!==opened.ownerId)return null
  return createPortal(<AssistantWorkTaskWindow ownerId={user.id} request={opened.request}/>,slot)
}
