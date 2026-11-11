// #1925 (API 46) An App's panel showing one task of the person's own assistant(形制同 appConversationSurfaceBridge:window
// 上一个对象 + getSnapshot / subscribe)。两棵树:
//   · 壳(components/appSlot/AppWorkLedgerHost.tsx)按内置「任务」列表同一份读法读账本,记下此刻的行;主进程验过权之后
//     (`gugu.bindings.openWork`)经会话页的 host action 叫这里 `open`,壳据自己记下的那一行拼出内置任务窗要的那一份,
//     画进 App 那一块面板里留的格子(lib/shellSlots.ts 的 `app-work:<App id>`)—— 画的就是内置那个 AssistantWorkTaskWindow;
//   · 会话页(features/apps/app-work-slot.tsx)看这里有没有那个 App 的一份:有 = 面板里不摆 App 的页,留出那一格。
// 桥只由壳装;会话页 bundle 只读 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。App 的页面够不着这里。
import type { AssistantTaskChat } from './assistantTaskChat'

/** One App's panel's task: whose account it was opened for, and what the built-in task window opens. */
export type AppWorkChat = { ownerId: string; request: AssistantTaskChat & { workId: string } }
export type AppWorkChats = Readonly<Record<string, AppWorkChat>>

export interface AppWorkChatBridge {
  /** 会话页(host action `openWork`):main 验过的账号与那一行;壳此刻读到的不是这个账号的、或没有这一行 = 抛,不画。 */
  open(extensionId: string, target: { ownerId: string; workId: string; sessionId: string }): void
  /** 会话页(host action `closeWork`):收起;没开着 = 什么都不变。 */
  close(extensionId: string): void
  getSnapshot(): AppWorkChats
  subscribe(listener: () => void): () => void
}

export const APP_WORK_CHAT_BRIDGE_KEY = '__GUGU_APP_WORK_CHATS__' as const
type BridgeWindow = Window & { [APP_WORK_CHAT_BRIDGE_KEY]?: AppWorkChatBridge }

/** 壳读到的那一份:谁的、哪位助理的、每一行怎么打开(与内置列表点一行时同一个 `assistantPanelTaskChat`)。 */
type Rows = { ownerId: string; assistantId: string; open: (workId: string, sessionId: string) => (AssistantTaskChat & { workId: string }) | null }

const NONE: AppWorkChats = Object.freeze({})
let current: AppWorkChats = NONE
let rows: Rows | null = null
const listeners = new Set<() => void>()

function publish(next: AppWorkChats): void {
  if (next === current) return
  current = Object.keys(next).length === 0 ? NONE : Object.freeze({ ...next })
  for (const listener of [...listeners]) listener()
}

const bridge: AppWorkChatBridge = {
  open: (extensionId, target) => {
    if (!rows || rows.ownerId !== target.ownerId) throw new Error('This window does not show that account\'s work now')
    const request = rows.open(target.workId, target.sessionId)
    if (!request) throw new Error('That task is not in the work list this window read')
    publish({ ...current, [extensionId]: { ownerId: target.ownerId, request } })
  },
  close: (extensionId) => {
    if (!Object.hasOwn(current, extensionId)) return
    const { [extensionId]: _closed, ...rest } = current
    publish(rest)
  },
  getSnapshot: () => current,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** 壳:装桥(幂等)。 */
export function installAppWorkChatBridge(w: Window = window): void {
  const target = w as BridgeWindow
  if (target[APP_WORK_CHAT_BRIDGE_KEY] !== bridge) target[APP_WORK_CHAT_BRIDGE_KEY] = bridge
}

/** 会话页:读 window 上那一个桥;壳还没装上 = null。 */
export function readAppWorkChatBridge(w: Window | undefined = typeof window === 'undefined' ? undefined : window): AppWorkChatBridge | null {
  return w ? (w as BridgeWindow)[APP_WORK_CHAT_BRIDGE_KEY] ?? null : null
}

/** 壳:此刻读到的行(null = 没在读:没登录、没有助理、没有 App 要);换了一份,开着的任务各自还留着,直到它自己的理由收起。 */
export function setAppWorkRows(next: Rows | null): void {
  rows = next
}

/** 壳:只留下 `keep` 说还能画的那几个(换了账号、离开会话页、App 停用 / 卸载 / 授权变了 → 当场收起)。 */
export function retainAppWorkChats(keep: (extensionId: string, chat: AppWorkChat) => boolean): void {
  const kept = Object.fromEntries(Object.entries(current).filter(([extensionId, chat]) => keep(extensionId, chat)))
  if (Object.keys(kept).length !== Object.keys(current).length) publish(kept)
}

/** 会话页在 App 面板里留给壳画任务对话的那一格(lib/shellSlots.ts 的公共格子表里的键)。 */
export const APP_WORK_SLOT_PREFIX = 'app-work:'
export const appWorkSlotKey = (extensionId: string) => `${APP_WORK_SLOT_PREFIX}${extensionId}`

/** Tests only. */
export function resetAppWorkChatsForTest(): void {
  rows = null
  current = NONE
}
