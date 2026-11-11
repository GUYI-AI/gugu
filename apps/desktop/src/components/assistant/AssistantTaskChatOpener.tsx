import { messageForUser } from '@/lib/userFacingError';
import { useEffect,useRef, useState, useSyncExternalStore } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { createPortal } from 'react-dom'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { useToast } from '../toastContext'
import { useTranslation } from 'react-i18next'
import { OPEN_ASSISTANT_TASK_CHAT, rememberAssistantTaskChat, showAssistantTaskChat, useOpenedAssistantTaskChat, type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantSlotKey } from '../../lib/assistantShellBridge'
import { readShellSlots } from '../../lib/shellSlots'
import { AssistantTaskChatWindow } from './AssistantTaskChatWindow'
import {AssistantWorkTaskWindow} from './AssistantWorkTaskWindow'
import { readRequiredDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'
import { assistantAppUsable, openAssistantTaskInApp } from '../../lib/assistantEntry'
import { followLink } from '../../lib/guguLinks'
import { resolveAssistantWorkTarget } from '../../lib/assistantWorkTarget'

const log = rendererLogger('assistant/task-chat-open')

/** `desktop`: the task's conversation opens over the assistant App's panel (the desktop has no other place for it). */
export function AssistantTaskChatOpener({ visible, desktop = false }: { visible: boolean; desktop?: boolean }) {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const { toast } = useToast()
  const { t } = useTranslation('assistant')
  const opened = useOpenedAssistantTaskChat()
  const [resolved, setResolved] = useState<{ ownerId: string; agent: ContactUser } | null>(null)
  const shellSlots = readShellSlots()
  const slot = useSyncExternalStore((listener) => shellSlots?.subscribeSlots(listener) ?? (() => undefined), () => shellSlots?.getSlots().get(assistantSlotKey('task-chat')) ?? null)
  const wasVisible=useRef(visible)
  useEffect(() => {
    const left=wasVisible.current&&!visible
    wasVisible.current=visible
    if(left||opened&&opened.ownerId!==user?.id)showAssistantTaskChat(null)
  }, [visible, user?.id, opened])
  useEffect(() => {
    let alive = true
    let pending: string | null = null
    let generation = 0
    const open = (event: Event) => {
      const request = (event as CustomEvent<AssistantTaskChat>).detail
      if (!user || pending === `${request.taskAgentId}:${request.workId ?? "legacy"}`) return
      const current = ++generation
      // Entry switch: the assistant's page is its App. The task's conversation opens over the App's panel (its host layer),
      // the same window the built-in panel drew; a task named without its work id is found in the assistant's work first.
      if (desktop) {
        // The App not usable here (switched off, going in, failing): the task is an ordinary task, opened as any session is.
        if (!assistantAppUsable()) {
          followLink({ kind: 'session', sessionId: request.task.sessionId, deviceId: request.task.deviceId })
          return
        }
        const ownerId = user.id
        const work = request.workId ? Promise.resolve(request as AssistantTaskChat & { workId: string })
          : resolveAssistantWorkTarget(request.assistantId, { ...(request.taskAgentId ? { agentId: request.taskAgentId } : { sessionId: request.task.sessionId }) })
            .then((found) => (found?.workId ? found as AssistantTaskChat & { workId: string } : null))
        void work.then((found) => {
          if (!alive || current !== generation) return
          if (!found) throw new Error('That task is not in the assistant\'s work')
          if (!openAssistantTaskInApp(ownerId, found)) throw new Error('The assistant App is not usable here now')
        }).catch((error: unknown) => {
          log.error({ error, taskAgentId: request.taskAgentId }, 'task chat not opened in the assistant App')
          if (alive && current === generation) toast(t('tasks.chatUnavailable'), 'error', messageForUser(error))
        })
        return
      }
      if(request.workId){
        showAssistantTaskChat({ownerId:user.id,request,name:request.title??t('tasks.title')})
        return
      }
      const show = (identities: readonly ContactUser[]) => {
        const owned = (id: string) => identities.find(contact => contact.id === id && contact.type === 'agent' && contact.owner_user_id === user.id)
        const task = request.taskAgentId?owned(request.taskAgentId):undefined
        if (!task || !owned(request.assistantId)) throw new Error('Task identity is not owned by the signed-in account')
        setResolved({ ownerId: user.id, agent: task })
        rememberAssistantTaskChat(user.id, request)
        showAssistantTaskChat({ ownerId: user.id, request, name: task.display_name })
      }
      const missing = [request.taskAgentId, request.assistantId].filter((id):id is string => !!id&&!contacts.some(contact => contact.id === id))
      if (missing.length === 0) {
        try { show(contacts) } catch (error) { log.error({ error: error }, 'action failed'); toast(t('tasks.chatUnavailable'), 'error', messageForUser(error)) }
        return
      }
      // A newly created agent reaches the session directory before the contacts snapshot.
      // Read its canonical identity, rather than treating a stale cache as a failed creation.
      pending = `${request.taskAgentId}:${request.workId ?? "legacy"}`
      void readRequiredDisplayIdentities(missing).then(identities => {
        if (alive && current === generation) show([...contacts, ...identities])
      }).catch((error: unknown) => {
        log.error({ error, taskAgentId: request.taskAgentId }, 'task identity read failed')
        if (alive && current === generation) toast(t('tasks.chatUnavailable'), 'error', messageForUser(error))
      }).finally(() => { if (current === generation) pending = null })
    }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, open)
    return () => { alive = false; window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, open) }
  }, [contacts, t, toast, user, desktop])
  const agent = opened && user && opened.ownerId === user.id ? contacts.find((contact) => contact.id === opened.request.taskAgentId)
    ?? (resolved && resolved.ownerId === user.id && resolved.agent.id === opened.request.taskAgentId ? resolved.agent : null) : null
  if(!visible||!slot)return null
  if(opened?.request.workId&&user?.id===opened.ownerId)return createPortal(<AssistantWorkTaskWindow ownerId={user.id} request={opened.request}/>,slot)
  if (!agent || !opened) return null
  const close = () => showAssistantTaskChat(null)
  return createPortal(<AssistantTaskChatWindow agent={agent} task={opened.request.task} onClose={close} />, slot)
}
