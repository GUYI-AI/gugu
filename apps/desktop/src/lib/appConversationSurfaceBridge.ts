// #1925 An App's main page beside the conversation its binding is bound to (形制同 assistantShellBridge:window 上一个
// 对象 + getSnapshot / subscribe)。两棵树:壳认定此刻能画哪条会话(登录的账号、装着的 App、`chat:surface` 授权、
// 仍在那条会话里 —— components/appSlot/AppConversationSurfaceHost.tsx),会话页的 App 整页据此摆出那一框,在左边留一格
// (lib/shellSlots.ts 的 `app-conversation:<App id>`),壳把原生会话 portal 进去。
// 桥只由壳装;会话页 bundle 只读 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。App 的页面够不着这里。

/** App id → the conversation the shell may draw beside its main page now. Absent: that App's page opens alone. */
export type AppConversationSurfaces = Readonly<Record<string, string>>
/**
 * #1925 (46) App id → the host's own row above that conversation (`contributes.conversationSurface.header`), for the account
 * main verified it for: only while the conversation is that account's private chat with its own assistant. Absent: no row.
 */
export type AppConversationHeaders = Readonly<Record<string, { kind: 'assistant'; ownerId: string }>>

export interface AppConversationSurfaceBridge {
  getSnapshot(): AppConversationSurfaces
  /** 46: the rows above those conversations; changes are told to the same listeners. */
  getHeaders(): AppConversationHeaders
  subscribe(listener: () => void): () => void
}

export const APP_CONVERSATION_SURFACE_BRIDGE_KEY = '__GUGU_APP_CONVERSATION_SURFACES__' as const
type BridgeWindow = Window & { [APP_CONVERSATION_SURFACE_BRIDGE_KEY]?: AppConversationSurfaceBridge }

const NONE: AppConversationSurfaces = Object.freeze({})
const NO_HEADERS: AppConversationHeaders = Object.freeze({})
let current: AppConversationSurfaces = NONE
let headers: AppConversationHeaders = NO_HEADERS
const listeners = new Set<() => void>()

const bridge: AppConversationSurfaceBridge = {
  getSnapshot: () => current,
  getHeaders: () => headers,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** 壳:装桥(幂等)。 */
export function installAppConversationSurfaceBridge(w: Window = window): void {
  const target = w as BridgeWindow
  if (target[APP_CONVERSATION_SURFACE_BRIDGE_KEY] !== bridge) target[APP_CONVERSATION_SURFACE_BRIDGE_KEY] = bridge
}

/** 壳:发布此刻能画的那几条,和它们上面那一行(没变就不通知);一行只给此刻画着的会话。 */
export function publishAppConversationSurfaces(next: AppConversationSurfaces, nextHeaders: AppConversationHeaders = NO_HEADERS): void {
  const keys = Object.keys(next)
  const rows = Object.fromEntries(Object.entries(nextHeaders).filter(([key]) => Object.hasOwn(next, key)))
  const sameSurfaces = keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])
  const sameHeaders = JSON.stringify(Object.entries(rows).sort()) === JSON.stringify(Object.entries(headers).sort())
  if (sameSurfaces && sameHeaders) return
  if (!sameSurfaces) current = keys.length === 0 ? NONE : Object.freeze({ ...next })
  if (!sameHeaders) headers = Object.keys(rows).length === 0 ? NO_HEADERS : Object.freeze(rows)
  for (const listener of listeners) listener()
}

/** 会话页:读 window 上那一个桥;壳还没装上 = null。 */
export function readAppConversationSurfaceBridge(w: Window | undefined = typeof window === 'undefined' ? undefined : window): AppConversationSurfaceBridge | null {
  return w ? (w as BridgeWindow)[APP_CONVERSATION_SURFACE_BRIDGE_KEY] ?? null : null
}

/** 会话页留给壳画原生会话的那一格(lib/shellSlots.ts 的公共格子表里的键)。 */
export const APP_CONVERSATION_SLOT_PREFIX = 'app-conversation:'
export const appConversationSlotKey = (extensionId: string) => `${APP_CONVERSATION_SLOT_PREFIX}${extensionId}`

/** 壳:此刻画在某个 App 旁边的会话(按画它的列数记)。 */
const drawn = new Map<string, number>()

/** 壳:这一列画上了这条会话;返回的函数在它不画时调。 */
export function noteAppConversationDrawn(chatId: string): () => void {
  drawn.set(chatId, (drawn.get(chatId) ?? 0) + 1)
  return () => {
    const left = (drawn.get(chatId) ?? 1) - 1
    if (left > 0) drawn.set(chatId, left)
    else drawn.delete(chatId)
  }
}

/** 壳:给这条会话的草稿(`gugu.dispatch`)落进 App 旁边已经画着的那个输入框,不必把会话调出来。 */
export function appConversationSurfaceShows(chatId: string): boolean {
  return (drawn.get(chatId) ?? 0) > 0
}
