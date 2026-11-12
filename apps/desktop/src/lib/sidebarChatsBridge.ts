// gugu-dev#181 会话页侧栏里的「对话」:列表本身由壳画进 `chat-list` 那一格(components/ChatListSlotHost.tsx),
// 这里是两棵树之间剩下的两样东西,各一个 window 对象 + 一个 window 事件(谁先起来都接得上,形制同 chatSummariesBridge):
//   · 壳 → 会话页:未读数。「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群叫到你的未读(话题只算叫到你的)。
//     只读未读数,❌ 在这里清:数只在真读了才减,切页签不算读。
//   · 会话页 → 壳:侧栏此刻在看什么 —— 搜索框里的字(一个框搜两边)、正看着的那块对话(那一行高亮)、拼在一屏的几组
//     (同一组的几行并在一处,同「项目」那边,lib/sidebarJoinedGroups)。
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { isDuplicateAssistantChat } from './assistantChatList'
import type { AssistantShellSnapshot } from './assistantShellBridge'
import type { JoinedGroup } from './sidebarJoinedGroups'

/** 会话页侧栏「对话」那一格在 lib/shellSlots 里的键:会话页登记,壳的 components/ChatListSlotHost.tsx 往里画。 */
export const CHAT_LIST_SLOT_KEY = 'chat-list'

export type SidebarChatSignals = {
  /** 「对话」那边(人、用户群和它们的话题)的未读总数,免打扰的不算。 */
  readonly chatsUnread: number
  /** 每个项目群叫到你的未读:群主线(含回复串)全算,从它开出来的话题只算叫到你的;免打扰的不算;没有的群不在里面。 */
  readonly groupUnread: ReadonlyMap<string, number>
  /** 项目群从哪个话题叫到了你:点项目行直接开它,读了 groupUnread 就减。没有叫到你的话题的群不在里面。 */
  readonly groupCallingTopic: ReadonlyMap<string, SidebarCallingTopic>
  /** #2569 the group chats the chat list has (project groups included); null = the list has not loaded yet. */
  readonly listedGroups: ReadonlySet<string> | null
}

export type SidebarCallingTopic = { readonly chatId: string; readonly name: string }

export type SidebarChatView = {
  readonly focusedChatId: string | null
  /** 拼在一屏的几组(这屏那一组和收起来的那些):「对话」里同一组的几行并在一处。 */
  readonly groups: readonly JoinedGroup[]
  /**
   * #2548 the task page's desktop sidebar (one list) is mounted and published this view. The phone never mounts it, so
   * absent = the phone: shared components (chat list, composer verbs, the rail's 消息) read this to tell, never settings.
   */
  readonly oneList?: boolean
}

/**
 * #2548 固定到左侧栏: an agent of mine that lives in a group or a project, pinned to the top of the one list.
 * 会话页 → 壳: the task page knows my sessions and where their agents live; the shell draws the agent's DM row.
 */
export type SidebarPinnedAgent = {
  readonly agentUserId: string
  /** The pinned session: 取消固定到左侧栏 writes it. */
  readonly sessionId: string
  /** Where the agent lives (the group, or the project's project group): its row says so, and clicking it opens that. */
  readonly home: { readonly kind: 'group' | 'project'; readonly name: string; readonly chatId: string }
}

const SIGNALS_KEY = '__GUGU_SIDEBAR_CHAT_SIGNALS__'
const SIGNALS_EVENT = 'gugu:sidebar-chat-signals'
const VIEW_KEY = '__GUGU_SIDEBAR_CHAT_VIEW__'
const VIEW_EVENT = 'gugu:sidebar-chat-view'
const NOTIFICATIONS_KEY = '__GUGU_SIDEBAR_NOTIFICATIONS_OPEN__'
const NOTIFICATIONS_EVENT = 'gugu:sidebar-notifications-open'
const PINNED_AGENTS_KEY = '__GUGU_SIDEBAR_PINNED_AGENTS__'
const PINNED_AGENTS_EVENT = 'gugu:sidebar-pinned-agents'
const TOUR_KEY = '__GUGU_PRODUCT_TOUR_ON_SCREEN__'
const TOUR_EVENT = 'gugu:product-tour-on-screen'

/**
 * 壳:从聊天列表那一份算出两枚页签和项目行上的数。项目群(及从它开出来的话题)的未读记在那个群名下,其余记进「对话」;免打扰的不算(gugu-dev#181:
 * 「对话」页签挂对话那边的未读总数,项目行与「项目」页签挂项目群的未读;owner 10-28:话题只算叫到你的)。只读未读数,真读了它自己会减。
 */
export function sidebarChatSignals(chats: readonly ChatItem[], projectGroupChats: ReadonlySet<string>, assistant: AssistantShellSnapshot | null = null, loaded = true): SidebarChatSignals {
  const listedGroups = loaded ? new Set(chats.flatMap((chat) => (chat.kind === 'group' ? [chat.id] : []))) : null
  let chatsUnread = 0
  const groupUnread = new Map<string, number>()
  const groupCallingTopic = new Map<string, SidebarCallingTopic>()
  for (const chat of chats) {
    if (chat.unread_count <= 0 || chat.is_muted || isDuplicateAssistantChat(chat, assistant)) continue
    const line = chat.kind === 'topic' ? (chat.source_chat_id ?? chat.id) : chat.id
    // 项目群主线(含回复串)全算,话题只算叫到你的那几条(owner 10-28),项目行与「对话」页签同一个数。
    const count = chatAttention(chat).forYou
    if (projectGroupChats.has(line)) {
      if (count > 0) groupUnread.set(line, (groupUnread.get(line) ?? 0) + count)
      if (count > 0 && chat.kind === 'topic' && !groupCallingTopic.has(line)) groupCallingTopic.set(line, { chatId: chat.id, name: chat.name ?? '' })
    } else chatsUnread += count
  }
  return { chatsUnread, groupUnread, groupCallingTopic, listedGroups }
}

const NO_VIEW: SidebarChatView = { focusedChatId: null, groups: [] }

function read<T>(key: string): T | null {
  return ((window as unknown as Record<string, unknown>)[key] as T | undefined) ?? null
}

function write(key: string, event: string, value: unknown): void {
  const target = window as unknown as Record<string, unknown>
  target[key] = value
  window.dispatchEvent(new Event(event))
}

const subscribeTo = (event: string) => (listener: () => void) => {
  window.addEventListener(event, listener)
  return () => window.removeEventListener(event, listener)
}
const subscribeSignals = subscribeTo(SIGNALS_EVENT)
const subscribeView = subscribeTo(VIEW_EVENT)
const subscribeNotifications = subscribeTo(NOTIFICATIONS_EVENT)
const subscribePinnedAgents = subscribeTo(PINNED_AGENTS_EVENT)
const NO_PINNED_AGENTS: readonly SidebarPinnedAgent[] = []

/** One ephemeral list-view choice across the shell and workspace roots; layout settings stay separate. */
export function setSidebarNotificationsOpen(open: boolean): void {
  if ((read<boolean>(NOTIFICATIONS_KEY) ?? false) === open) return
  write(NOTIFICATIONS_KEY, NOTIFICATIONS_EVENT, open)
}

export function useSidebarNotificationsOpen(): boolean {
  return useSyncExternalStore(subscribeNotifications, () => read<boolean>(NOTIFICATIONS_KEY) ?? false, () => false)
}

const subscribeTour = subscribeTo(TOUR_EVENT)

/** 壳:功能导览正在屏幕上(#2548:侧栏的两步介绍这时让开,❌ 两个气泡同时出来)。 */
export function setProductTourOnScreen(onScreen: boolean): void {
  if ((read<boolean>(TOUR_KEY) ?? false) === onScreen) return
  write(TOUR_KEY, TOUR_EVENT, onScreen)
}

export function useProductTourOnScreen(): boolean {
  return useSyncExternalStore(subscribeTour, () => read<boolean>(TOUR_KEY) ?? false, () => false)
}

function sameIds(current: ReadonlySet<string> | null, next: ReadonlySet<string> | null): boolean {
  if (current === null || next === null) return current === next
  return current.size === next.size && [...next].every((id) => current.has(id))
}

/** 壳:整份替换;没变不通知。 */
export function publishSidebarChatSignals(next: SidebarChatSignals): void {
  const current = read<SidebarChatSignals>(SIGNALS_KEY)
  if (
    current &&
    current.chatsUnread === next.chatsUnread &&
    current.groupUnread.size === next.groupUnread.size &&
    [...next.groupUnread].every(([chatId, count]) => current.groupUnread.get(chatId) === count) &&
    current.groupCallingTopic.size === next.groupCallingTopic.size &&
    [...next.groupCallingTopic].every(([chatId, topic]) => current.groupCallingTopic.get(chatId)?.chatId === topic.chatId && current.groupCallingTopic.get(chatId)?.name === topic.name) &&
    sameIds(current.listedGroups, next.listedGroups)
  ) return
  write(SIGNALS_KEY, SIGNALS_EVENT, next)
}

/** 会话页,在 React 之外(#2569 示例让位给它变成的项目那一下):此刻这一份;壳还没告诉过 = null。 */
export function readSidebarChatSignals(): SidebarChatSignals | null {
  return read<SidebarChatSignals>(SIGNALS_KEY)
}

/** 会话页,在 React 之外:壳每换一份就同步叫一次(叫的那一刻,侧栏还没按新的这一份重画)。 */
export function subscribeSidebarChatSignals(listener: () => void): () => void {
  return subscribeSignals(listener)
}

/** 会话页:壳还没告诉过 = null(还不知道,页签上先不挂数)。 */
export function useSidebarChatSignals(): SidebarChatSignals | null {
  return useSyncExternalStore(subscribeSignals, () => read<SidebarChatSignals>(SIGNALS_KEY), () => null)
}

/** 会话页:侧栏在看什么;没变不通知。 */
export function publishSidebarChatView(next: SidebarChatView): void {
  const current = read<SidebarChatView>(VIEW_KEY)
  if (
    current &&
    current.focusedChatId === next.focusedChatId &&
    JSON.stringify(current.groups) === JSON.stringify(next.groups) &&
    (current.oneList ?? false) === (next.oneList ?? false)
  ) return
  write(VIEW_KEY, VIEW_EVENT, next)
}

/** 壳:会话页还没说过 = 没看着哪条对话。 */
export function useSidebarChatView(): SidebarChatView {
  return useSyncExternalStore(subscribeView, () => read<SidebarChatView>(VIEW_KEY) ?? NO_VIEW, () => NO_VIEW)
}

/** 会话页:the agents pinned to the one list, in display order (整份替换;没变不通知). */
export function publishSidebarPinnedAgents(next: readonly SidebarPinnedAgent[]): void {
  const current = read<readonly SidebarPinnedAgent[]>(PINNED_AGENTS_KEY)
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  write(PINNED_AGENTS_KEY, PINNED_AGENTS_EVENT, next)
}

/** 壳:the agents pinned to the one list, in display order; the task page has not said yet = none. */
export function useSidebarPinnedAgents(): readonly SidebarPinnedAgent[] {
  return useSyncExternalStore(subscribePinnedAgents, () => read<readonly SidebarPinnedAgent[]>(PINNED_AGENTS_KEY) ?? NO_PINNED_AGENTS, () => NO_PINNED_AGENTS)
}

/**
 * #2548 壳 → 会话页: an account project with no conversation row yet stands among the conversation rows at its time
 * (lib/sidebarOneList, OneListProjectLine). Where is the chat list's to say, the row is the task page's to draw (it needs
 * the task page's own context): the chat list leaves an empty element there, a shell slot (lib/shellSlots) under this key
 * with the project's group chat id, and the task page draws the project's row into it.
 */
export const ONE_LIST_PROJECT_SLOT_PREFIX = 'one-list-project:'
export const oneListProjectSlotKey = (chatId: string) => `${ONE_LIST_PROJECT_SLOT_PREFIX}${chatId}`

const ONE_LIST_NEIGHBOUR_KEY = '__GUGU_SIDEBAR_ONE_LIST_NEIGHBOUR__'

/**
 * #2548 壳 → 会话页: the one list's rows are the chat list's, and so is their keyboard order (⌘↑/⌘↓). ⌃X⌃X on the task page
 * archives the open task, then moves on as the old sidebar did: to the row after the lit one (the one before it at the
 * end), opened as ⌘↓ opens it. The chat list installs this while it is the one list. Returns the uninstall.
 */
export function installOneListNeighbour(open: () => boolean): () => void {
  const target = window as unknown as Record<string, unknown>
  target[ONE_LIST_NEIGHBOUR_KEY] = open
  return () => {
    if (target[ONE_LIST_NEIGHBOUR_KEY] === open) delete target[ONE_LIST_NEIGHBOUR_KEY]
  }
}

/** 会话页: open the one list's row next to the lit one; false = there is none (no other row, no lit row, no one list). */
export function openOneListNeighbour(): boolean {
  return read<() => boolean>(ONE_LIST_NEIGHBOUR_KEY)?.() ?? false
}

export type ShellChatDialog = 'create-group' | 'add-contact'
export type ShellChatAction = ShellChatDialog | { kind: 'mark-read'; chatId: string }

const ACTION_KEY = '__GUGU_SIDEBAR_CHAT_ACTION__'
const ACTION_EVENT = 'gugu:sidebar-chat-action'

/**
 * 会话页:新建群聊 / 添加联系人(侧栏「对话」页那两行、⌘K 面板)。弹窗是侧栏里那份对话列表的,那份列表此刻可能还没挂上
 * (人在「项目」页):请求先存着,列表挂上或收到通知时取走 —— ❌ 发一个没人听的事件就丢了。
 */
export function requestShellChatAction(action: ShellChatAction): void {
  write(ACTION_KEY, ACTION_EVENT, action)
}

/** 壳:取走一个还没办、归自己办的请求(侧栏那份对话列表办弹窗);取一次就没了。 */
export function takeShellChatAction<A extends ShellChatAction>(mine: (action: ShellChatAction) => action is A): A | null {
  const action = read<ShellChatAction>(ACTION_KEY)
  if (!action || !mine(action)) return null
  ;(window as unknown as Record<string, unknown>)[ACTION_KEY] = null
  return action
}

export const subscribeShellChatActions = subscribeTo(ACTION_EVENT)
