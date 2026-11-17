import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { OPEN_LINK_TARGET, OpenSuperseded, type LinkNavigation } from '../lib/guguLinks'
import { askedSince, asksSoFar, beginWait, endWait } from '../session/renderer/features/chats/chat-tabs/chat-layouts'
import type { AppDetailLink, GuguLinkTarget } from '@gugu/core/shared/ui/guguLink'
import type { AppOpenWithDetail } from '../session/shared/extensions/app-runtime-protocol'
import { readMobileShell } from './useMobileShell'
import { SERVER_LOGIN_APPROVE_EVENT } from '../lib/inAppLinks'
import { readAssistantShellBridge } from '../lib/assistantShellBridge'
import { assistantAppUsable } from '../lib/assistantEntry'
import { OPEN_ASSISTANT_TASK_CHAT, readAssistantTaskChat, type AssistantTaskChat } from '../lib/assistantTaskChat'
import { UI_EVENTS } from '../lib/uiEvents'
import { chatService } from '../lib/chat'
import { askReveal } from './useSourceMessageReveal'
import { readIdentityDirectoryBridge } from '../lib/identityDirectoryBridge'
import { openOwnedAgentFile } from '../lib/ownedAgentConversation'

/**
 * Whether the assistant's tasks have their place here: the phone's own layer, or on a computer the assistant App (the one
 * decision, lib/assistantEntry.ts). Not: the task is an ordinary one, opened as any chat or session is.
 */
const assistantTasksHavePlace = () => readMobileShell() || assistantAppUsable()

/** The navigation belongs to the chat shell, not a Markdown renderer or an agent. */
export function useLinkNavigation(input: {
  ownerId: string
  /** Read when a link opens: the shell does not subscribe to the chat list or contacts for this. */
  chats: () => readonly ChatItem[]
  contacts: () => readonly ContactUser[]
  openChat: (chatId: string) => string | void
  openSender?: (sender: ContactUser, sourceChatId?: string) => Promise<void> | void
  openFile: (chatId: string, target: Extract<GuguLinkTarget, { kind: 'file' }>, source: Pick<LinkNavigation, 'message' | 'restore'>, opener: AppOpenWithDetail) => void | Promise<void>
  openApp: (chatId: string, extensionId: string, tab: string) => void
  openProject: (projectId: string) => void
  openAppDetail?: (target: AppDetailLink) => void | Promise<void>
  openOwnApp: (extensionId: string, tab: string) => void
  openAssistant: (tasks: boolean) => string | void
}) {
  const current = useRef(input)
  current.current = input
  const { t } = useTranslation('assistant')
  const messages = useRef({ t })
  messages.current = { t }
  useEffect(() => {
    let generation = 0
    const open = async (request: LinkNavigation) => {
      const { target } = request
      const asked = generation
      const state = current.current
      if (target.kind === 'sender') {
        const sender = state.contacts().find(contact => contact.id === target.userId)
          ?? readIdentityDirectoryBridge()?.getSnapshot()?.[target.userId]
        if (!target.file && (!sender || !state.openSender)) throw new Error(messages.current.t('links.unavailable'))
        let sourceChatId: string | undefined
        if (target.sourceChatId && !readMobileShell()) {
          const source = state.chats().find(chat => chat.id === target.sourceChatId)
          if (!source || (source.kind !== 'group' && source.kind !== 'topic')) throw new Error(messages.current.t('links.unavailable'))
          sourceChatId = (source.kind === 'topic' ? source.source_chat_id : source.id) ?? undefined
          if (!sourceChatId) throw new Error(messages.current.t('links.unavailable'))
        }
        // Only an agent of this person's has a task here to read its path in.
        if (target.file) {
          if (!openOwnedAgentFile(target.userId, sourceChatId, target.file)) throw new Error(messages.current.t('links.fileOnSenderMachine'))
        } else if (sourceChatId) await state.openSender!(sender!, sourceChatId)
        else await state.openSender!(sender!)
        return 'own' as const
      }
      if (target.kind === 'file') {
        // The chat whose panel shows a chat's files (a topic's: its source's).
        const panelChat = (id: string | undefined) => {
          const row = id ? state.chats().find((chat) => chat.id === id) : undefined
          return row ? (row.kind === 'topic' ? row.source_chat_id ?? null : row.id) : null
        }
        // Asked in a chat (a message's, or an App page's beside it): the file's waiting page there at once.
        const { from, intent } = request
        const here = from?.chatId ?? panelChat(request.message?.chat_id)
        const wait = here ? beginWait(here, { itemId: target.itemId, ...(request.fileName ? { fileName: request.fileName } : {}), ...(request.message ? { message: request.message } : {}), ...(from ? { from: from.tabId } : {}), ...(intent ? { intent } : {}) }) : null
        const mark = asksSoFar()
        try {
          // One answer from the host: the file's chat, what it is and who opens it. The chat opens what was answered.
          const { appsHere } = await import('../components/appSlot/appsHere')
          if (!appsHere) throw new Error('The file opener is unavailable')
          const found = await appsHere.groupFileOpener({ itemId: target.itemId, ...(request.chatId ? { chatId: request.chatId } : {}), ...(target.at ? { at: target.at } : {}) })
          if (asked !== generation || current.current.ownerId !== state.ownerId) throw new OpenSuperseded()
          if (!found.success || !found.data) throw Object.assign(new Error(found.error || 'File reference is unavailable'), 'code' in found && found.code ? { code: found.code } : {})
          const chatId = panelChat(found.data.chatId)
          if (!chatId) throw new Error('File reference is unavailable')
          // Something else was asked of that chat while the host answered (a file from an App's list, another link): it is
          // the one the chat opens.
          if (askedSince(chatId, mark)) throw new OpenSuperseded()
          // Another chat's file (a forwarded one): nothing waits here; that chat comes up with it.
          if (wait && chatId !== here) endWait(here!, wait)
          await state.openFile(chatId, target, request, { ...found.data, ...(wait && chatId === here ? { wait } : {}), ...(intent ? { intent } : {}), ...(from?.chatId === chatId ? { from: from.tabId } : {}) })
          window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
          return
        } finally {
          // Not turned into the file (failed, superseded, picked, another chat's): its waiting page goes.
          if (wait) endWait(here!, wait)
        }
      }
      if (target.kind === 'app' && !target.place) { state.openOwnApp(target.extensionId, target.tab); return 'own' as const }
      if (target.kind === 'app' && target.place && 'chat' in target.place) {
        const chatId = target.place.chat
        if (!state.chats().some((row) => row.id === chatId)) throw new Error('App chat is unavailable')
        state.openApp(chatId, target.extensionId, target.tab)
        window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
        return { chat: chatId }
      }
      if (target.kind === 'app-detail') {
        if (readMobileShell()) {
          if (!state.openAppDetail) {
            const { translateSessionMessage } = await import('../session/renderer/localization/locale-store')
            throw new Error(translateSessionMessage('extensions.appLinkOnPhone'))
          }
          await state.openAppDetail(target)
        } else {
          const { openAppDetailLink } = await import('../session/renderer/features/apps/app-detail-link')
          await openAppDetailLink(target, state.ownerId, () => asked === generation && current.current.ownerId === state.ownerId)
        }
        return
      }
      if (target.kind === 'session') {
        const assistant=readAssistantShellBridge()?.getSnapshot()
        // A task of the assistant's has its place over the App's panel; without one, it is an ordinary task, brought up as any session is.
        if(assistant?.assistant&&assistantTasksHavePlace()){
          const {resolveAssistantWorkTarget}=await import('../lib/assistantWorkTarget')
          const task=await resolveAssistantWorkTarget(assistant.assistant.id,{sessionId:target.sessionId})
          if(asked!==generation||current.current.ownerId!==state.ownerId)return
          if(task){window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:task}));return 'own' as const}
        }
        // Any other session: the host's task list brings it up (openLinkWith → its sessionProject / bringUp).
        return
      }
      if (target.kind === 'project') {
        if (!readMobileShell()) state.openProject(target.projectId)
        else {
          const [{ deviceSessionsOf, liveDeviceSessions }, { readCachedDevices }, { APP_SHOW_SESSION_EVENT }] = await Promise.all([
            import('../session/shared/remote-sessions/session-directory'), import('../store/devicesCache'), import('../session/shared/extensions/app-runtime-protocol'),
          ])
          if (!readCachedDevices().some((device) => deviceSessionsOf(device, liveDeviceSessions()).projects.some((project) => project.id === target.projectId))) throw new Error('Project is not in your task list')
          window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { projectId: target.projectId } }))
        }
        return
      }
      if (target.kind === 'server-login') {
        if (window.dispatchEvent(new CustomEvent(SERVER_LOGIN_APPROVE_EVENT, { detail: { code: target.code }, cancelable: true }))) throw new Error('No login approval page in this shell')
        return
      }
      if (target.kind !== 'chat') throw new Error('This target is not available in the chat shell')
      const chat = state.chats().find((row) => row.id === target.chatId)
      if (!target || !chat) throw new Error('Conversation reference is unavailable')
      if (target.messageId) {
        const message = await chatService.getMessageById(target.messageId, state.ownerId)
        if (!message || message.chat_id !== chat.id || message.retracted_at) throw new Error('Message reference is unavailable')
      }
      if (asked !== generation || current.current.ownerId !== state.ownerId) return
      const assistant = readAssistantShellBridge()?.getSnapshot()
      let task: AssistantTaskChat | null = null
      const contact = state.contacts().find((row) => row.id === chat.peer_user_id)
      if (assistant?.assistant && contact?.type === 'agent' && contact.owner_user_id === state.ownerId
        && contact.id !== assistant.assistant.id && assistantTasksHavePlace()) {
        // Choosing the known task viewport must not wait for its cloud reader to be ready.
        const known=readAssistantTaskChat(state.ownerId,contact.id)
        if(known?.assistantId===assistant.assistant.id)task=known
        else {
          const {resolveAssistantWorkTarget}=await import('../lib/assistantWorkTarget')
          task=await resolveAssistantWorkTarget(assistant.assistant.id,{agentId:contact.id})
        }
      }
      if (asked !== generation || current.current.ownerId !== state.ownerId) return
      let viewportKey: string | void
      if (chat.id === assistant?.chatId) viewportKey = state.openAssistant(false)
      else if (task) {
        viewportKey = state.openAssistant(true)
        window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT, { detail: task }))
      } else viewportKey = state.openChat(chat.id)
      if (target.messageId) askReveal(chat.id, target.messageId, viewportKey || undefined)
      window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: chat.id } }))
    }
    // The file being opened now: asked for again before it is up (a second click), the ask joins it — one open, one answer.
    let opening: { file: string; done: ReturnType<typeof open> } | null = null
    const receive = (event: Event) => {
      const request = (event as CustomEvent<LinkNavigation>).detail
      if (!request) return
      event.preventDefault()
      const file = request.target.kind === 'file' ? JSON.stringify(request.target) : null
      if (file && opening?.file === file) { void opening.done.then(request.resolve, request.reject); return }
      ++generation
      const asked = generation
      const owner = current.current.ownerId
      const done: ReturnType<typeof open> = open(request).catch((error: unknown) => {
        if ((asked !== generation || owner !== current.current.ownerId) && request.target.kind !== 'file') return undefined
        throw error instanceof OpenSuperseded ? error : targetError(request.target, error, messages.current.t('links.unavailable'))
      }).finally(() => { if (opening?.done === done) opening = null })
      if (file) opening = { file, done }
      void done.then(request.resolve, request.reject)
    }
    const receiveTask = () => { generation++; current.current.openAssistant(true) }
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask)
    window.addEventListener(OPEN_LINK_TARGET, receive)
    return () => { generation++; window.removeEventListener(OPEN_LINK_TARGET, receive); window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, receiveTask) }
  }, [])
}

function targetError(target: LinkNavigation['target'], error: unknown, fallback: string) {
  return new Error((target.kind === 'app-detail' || (target.kind === 'sender' && target.file)) && error instanceof Error ? error.message : fallback, { cause: error })
}
