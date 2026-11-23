// #2548 桌面内层侧栏(打开一个群 / 项目时列表右边那一列)要两棵树一起画:话题行是壳的(聊天列表那一行),
// 智能体行是会话页的(任务区那一行)。两棵树之间剩下的几样东西各一个 window 对象 + 一个 window 事件
// (谁先起来都接得上,形制同 sidebarChatsBridge):
//   · 「全部话题」:哪个对话的话题此刻全部摊开。会话页的分区头「全部 › / ‹ 返回」写,壳那一格读。
//   · 话题读数:壳 → 会话页。分区头上的总数,以及第一级收起了几条(决定要不要给「全部 ›」)。
//   · 我的智能体读数:会话页 → 壳。每个项目群 / 用户群里住着的我的智能体有几个、几个在跑 —— 项目行、群行头像角上那个数(#2599)。
//   · 这一列在不在:会话页 → 壳。在的话群页头上与它重复的话题钮收起来 —— 按到哪一块,这一列就挂到哪一块,不聚焦那块的钮按下去只会换焦点。
//   · 一个列表画成自己一行的我的智能体(#2574):壳 → 会话页。有子智能体的独立智能体那一列只开在这几行上 —— 「有自己一行」只有列表这一份判法。
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useEffect, useSyncExternalStore } from 'react'

/** 内层侧栏「话题」那一格在 lib/shellSlots 里的键前缀:会话页登记,壳的 components/ChatListSlotHost.tsx 往里画。 */
export const INNER_SIDEBAR_TOPICS_SLOT_PREFIX = 'inner-topics:'
export const innerSidebarTopicsSlotKey = (chatId: string) => `${INNER_SIDEBAR_TOPICS_SLOT_PREFIX}${chatId}`
/** 「全部 ›」打开的话题页:这个群 / 项目那一块里的格子,壳把全部话题画进来(ChatListSlotHost)。 */
export const TOPICS_PAGE_SLOT_PREFIX = 'topics-page:'
export const topicsPageSlotKey = (chatId: string) => `${TOPICS_PAGE_SLOT_PREFIX}${chatId}`

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
const COLUMN_KEY = '__GUGU_INNER_SIDEBAR_PRESENT__'
const COLUMN_EVENT = 'gugu:inner-sidebar-present'
const AGENT_ROWS_KEY = '__GUGU_ONE_LIST_AGENT_ROWS__'
const AGENT_ROWS_EVENT = 'gugu:one-list-agent-rows'

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
const subscribeAgentRows = subscribeTo(AGENT_ROWS_EVENT)

/** 打开这个对话的话题页(「全部 ›」,开在它那一块里);null = 关掉。没变不通知。 */
export function setInnerSidebarTopicsAll(chatId: string | null): void {
  if (read<string>(TOPICS_ALL_KEY) === chatId) return
  write(TOPICS_ALL_KEY, TOPICS_ALL_EVENT, chatId)
}

/** 此刻开着话题页的那个对话;没有 = null。 */
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

/** 会话页:每个项目群 / 用户群里住着的我的智能体(整份替换;没变不通知)。开关关着时发一份空的。 */
export function publishMyChatAgentCounts(next: ReadonlyMap<string, ChatAgentCounts>): void {
  const current = read<ReadonlyMap<string, ChatAgentCounts>>(AGENT_COUNTS_KEY)
  if (
    current &&
    current.size === next.size &&
    [...next].every(([chatId, counts]) => current.get(chatId)?.total === counts.total && current.get(chatId)?.running === counts.running)
  ) return
  write(AGENT_COUNTS_KEY, AGENT_COUNTS_EVENT, next)
}

/** 壳:这个对话里我的智能体;不是项目群或用户群、会话页还没说过、或开关关着 = null。 */
export function useMyChatAgentCounts(chatId: string): ChatAgentCounts | null {
  return useSyncExternalStore(
    subscribeAgentCounts,
    () => (read<ReadonlyMap<string, ChatAgentCounts>>(AGENT_COUNTS_KEY) ?? NO_COUNTS).get(chatId) ?? null,
    () => null,
  )
}

/** 会话页:这一列在这个窗口里有没有(收起着也算有:展开钮就在)。没变不通知。 */
export function publishInnerSidebarPresent(present: boolean): void {
  if (read<boolean>(COLUMN_KEY) === present) return
  write(COLUMN_KEY, COLUMN_EVENT, present)
}

/** 壳:这个窗口有内层侧栏(焦点挪到哪个群 / 项目,它就画哪个的话题)。手机、弹出窗口、列表栏藏着 = false。 */
export function useInnerSidebarPresent(): boolean {
  return useSyncExternalStore(subscribeColumn, () => read<boolean>(COLUMN_KEY) === true, () => false)
}

/** #2574 一个列表里我的一个智能体自己那一行(和它的私聊),画成什么样:内层栏的头一行照着它画。 */
export type OneListAgentRow = {
  readonly chatId: string
  /** 那一行的名字(未经「起名中」那一层,同行组件拿到的那一个)。 */
  readonly name: string
  readonly avatar: string | null
  readonly createdAt: string | null
}

/** agent → 它自己那一行;null = 一个列表不在(还没读到、开关关着、手机)。 */
export type OneListAgentRows = ReadonlyMap<string, OneListAgentRow>

function sameRows(a: OneListAgentRows | null, b: OneListAgentRows | null): boolean {
  if (a === null || b === null) return a === b
  return a.size === b.size && [...b].every(([agentUserId, row]) => {
    const was = a.get(agentUserId)
    return was?.chatId === row.chatId && was.name === row.name && was.avatar === row.avatar && was.createdAt === row.createdAt
  })
}

/** 壳:整份替换;没变不通知。 */
export function publishOneListAgentRows(next: OneListAgentRows | null): void {
  if (sameRows(read<OneListAgentRows>(AGENT_ROWS_KEY), next)) return
  write(AGENT_ROWS_KEY, AGENT_ROWS_EVENT, next)
}

/** 壳(一个列表那一份聊天列表):每次画完发一份,卸下时收回。`rows` null = 这一份不是一个列表,什么都不发。 */
export function usePublishOneListAgentRows(rows: OneListAgentRows | null): void {
  const key = rows ? JSON.stringify([...rows]) : null
  useEffect(() => {
    if (rows) publishOneListAgentRows(rows)
    // 依赖是序列化后的那一份:每次渲染新建的 Map 不算变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const on = rows !== null
  useEffect(() => (on ? () => publishOneListAgentRows(null) : undefined), [on])
}

/** 会话页:一个列表画成自己一行的我的智能体;一个列表还没说过 = null。 */
export function useOneListAgentRows(): OneListAgentRows | null {
  return useSyncExternalStore(subscribeAgentRows, () => read<OneListAgentRows>(AGENT_ROWS_KEY), () => null)
}
