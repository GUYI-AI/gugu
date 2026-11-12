// #2548 桌面内层侧栏(打开一个群 / 项目时列表右边那一列)要两棵树一起画:话题行是壳的(聊天列表那一行),
// 智能体行是会话页的(任务区那一行)。两棵树之间剩下的几样东西各一个 window 对象 + 一个 window 事件
// (谁先起来都接得上,形制同 sidebarChatsBridge):
//   · 「全部话题」:哪个对话的话题此刻全部摊开。会话页的分区头「全部 › / ‹ 返回」写,壳那一格读。
//   · 话题读数:壳 → 会话页。分区头上的总数,以及第一级收起了几条(决定要不要给「全部 ›」)。
//   · 我的智能体读数:会话页 → 壳。每个项目群里我的智能体有几个、几个在跑 —— 项目行头像角上那个数。
//   · 这一列此刻挂在哪个对话上:会话页 → 壳。挂着时那个对话页头上与这一列重复的按钮(成员、话题、邀请)收起来。
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'

/** 内层侧栏「话题」那一格在 lib/shellSlots 里的键前缀:会话页登记,壳的 components/ChatListSlotHost.tsx 往里画。 */
export const INNER_SIDEBAR_TOPICS_SLOT_PREFIX = 'inner-topics:'
export const innerSidebarTopicsSlotKey = (chatId: string) => `${INNER_SIDEBAR_TOPICS_SLOT_PREFIX}${chatId}`

export type InnerSidebarTopicsView = {
  readonly chatId: string
  /** 这个对话的话题总数。 */
  readonly total: number
  /** 第一级收起来的条数(0 = 第一级已经是全部)。 */
  readonly hidden: number
  /** 叫到我的(@ 我)合计:分区收起时标题旁那个红数。 */
  readonly calling: number
}

/** 一个对话里我的智能体:总数与此刻在跑的(前台运行,同分支计数那枚药丸)。 */
export type ChatAgentCounts = { readonly total: number; readonly running: number }

const TOPICS_ALL_KEY = '__GUGU_INNER_SIDEBAR_TOPICS_ALL__'
const TOPICS_ALL_EVENT = 'gugu:inner-sidebar-topics-all'
const TOPICS_VIEW_KEY = '__GUGU_INNER_SIDEBAR_TOPICS_VIEW__'
const TOPICS_VIEW_EVENT = 'gugu:inner-sidebar-topics-view'
const AGENT_COUNTS_KEY = '__GUGU_MY_CHAT_AGENT_COUNTS__'
const AGENT_COUNTS_EVENT = 'gugu:my-chat-agent-counts'
const COLUMN_KEY = '__GUGU_INNER_SIDEBAR_CHAT__'
const COLUMN_EVENT = 'gugu:inner-sidebar-chat'

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
const subscribeTopicsAll = subscribeTo(TOPICS_ALL_EVENT)
const subscribeTopicsView = subscribeTo(TOPICS_VIEW_EVENT)
const subscribeAgentCounts = subscribeTo(AGENT_COUNTS_EVENT)
const subscribeColumn = subscribeTo(COLUMN_EVENT)

/** 摊开这个对话的全部话题;null = 回到第一级。没变不通知。 */
export function setInnerSidebarTopicsAll(chatId: string | null): void {
  if (read<string>(TOPICS_ALL_KEY) === chatId) return
  write(TOPICS_ALL_KEY, TOPICS_ALL_EVENT, chatId)
}

/** 此刻摊开全部话题的那个对话;没有 = null。 */
export function useInnerSidebarTopicsAll(): string | null {
  return useSyncExternalStore(subscribeTopicsAll, () => read<string>(TOPICS_ALL_KEY), () => null)
}

/** 壳:话题读数(整份替换;没变不通知)。 */
export function publishInnerSidebarTopicsView(next: InnerSidebarTopicsView): void {
  const current = read<InnerSidebarTopicsView>(TOPICS_VIEW_KEY)
  if (
    current &&
    current.chatId === next.chatId &&
    current.total === next.total &&
    current.hidden === next.hidden &&
    current.calling === next.calling
  ) return
  write(TOPICS_VIEW_KEY, TOPICS_VIEW_EVENT, next)
}

/** 会话页:这个对话的话题读数;壳还没说过(那一格还没画上)= null。 */
export function useInnerSidebarTopicsView(chatId: string): InnerSidebarTopicsView | null {
  return useSyncExternalStore(subscribeTopicsView, () => {
    const view = read<InnerSidebarTopicsView>(TOPICS_VIEW_KEY)
    return view?.chatId === chatId ? view : null
  }, () => null)
}

const NO_COUNTS: ReadonlyMap<string, ChatAgentCounts> = new Map()

/** 会话页:每个项目群里我的智能体(整份替换;没变不通知)。开关关着时发一份空的。 */
export function publishMyChatAgentCounts(next: ReadonlyMap<string, ChatAgentCounts>): void {
  const current = read<ReadonlyMap<string, ChatAgentCounts>>(AGENT_COUNTS_KEY)
  if (
    current &&
    current.size === next.size &&
    [...next].every(([chatId, counts]) => current.get(chatId)?.total === counts.total && current.get(chatId)?.running === counts.running)
  ) return
  write(AGENT_COUNTS_KEY, AGENT_COUNTS_EVENT, next)
}

/** 壳:这个对话里我的智能体;不是项目群、会话页还没说过、或开关关着 = null。 */
export function useMyChatAgentCounts(chatId: string): ChatAgentCounts | null {
  return useSyncExternalStore(
    subscribeAgentCounts,
    () => (read<ReadonlyMap<string, ChatAgentCounts>>(AGENT_COUNTS_KEY) ?? NO_COUNTS).get(chatId) ?? null,
    () => null,
  )
}

/** 会话页:这一列此刻挂在哪个对话上(不画 = null)。没变不通知。 */
export function publishInnerSidebarChat(chatId: string | null): void {
  if (read<string>(COLUMN_KEY) === chatId) return
  write(COLUMN_KEY, COLUMN_EVENT, chatId)
}

/** 壳:这一列此刻挂在哪个对话上;没有(开关关着、不是群 / 项目、手机)= null。 */
export function useInnerSidebarChat(): string | null {
  return useSyncExternalStore(subscribeColumn, () => read<string>(COLUMN_KEY), () => null)
}
