// #1925 (API 44, 46) One host layer over an App's panel(形制同 appConversationSurfaceBridge:window 上一个对象 +
// getSnapshot / subscribe):一个 App 的面板上此刻盖着的那一页宿主自己的页(助理的某个任务的对话、助理的设置 / 项目 / 能力),
// 一次一页,开新的就收起旧的。种类与 main 那一侧的形状见 session/shared/extensions/app-host-layer.ts。两棵树:
//   · 壳(components/appSlot/AppHostLayerHost.tsx)把要壳来画的那几页画进 App 那一块面板里留的格子(lib/shellSlots.ts 的
//     `app-host-layer:<App id>`)—— 画的就是内置那一页本身(AssistantWorkTaskWindow、AssistantSettingsPage);
//     换账号、App 停用 / 卸载 / 授权变了、(任务)离开会话页 → 当场收起;每次开合告诉 main(App 只听到开着没有);
//   · 会话页(features/apps/app-host-layer.tsx)看这里有没有那个 App 的一页:有 = 不摆 App 的页,留出那一格或画那一页,
//     配上宿主自己的返回 / 收起。它也是开页的地方:main 验过权之后的 host action(`openWork`、`openAssistantScreen`),
//     宿主自己那一行的齿轮。
// 桥只由壳装;会话页 bundle 只读 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。App 的页面够不着这里。
import type { AppHostLayerPage } from '@/session/shared/extensions/app-host-layer'
import type { AssistantTaskChat } from './assistantTaskChat'

/** One App's panel's host page: which, and the account it was opened for (a task: what the built-in task window opens). */
export type AppHostLayer =
  | { kind: 'work'; ownerId: string; request: AssistantTaskChat & { workId: string } }
  | { kind: AppHostLayerPage; ownerId: string }
export type AppHostLayers = Readonly<Record<string, AppHostLayer>>

/** What opens one: a task by the ids main verified (it is drawn from the row the shell read), or a page of the host's. */
export type AppHostLayerTarget =
  | { kind: 'work'; ownerId: string; workId: string; sessionId: string }
  | { kind: AppHostLayerPage; ownerId: string }

export interface AppHostLayerBridge {
  /**
   * 会话页:在这个 App 的面板上开这一页(换掉开着的那一页)。壳此刻显示的不是这个账号 / 任务不在壳读到的那一份里 = 抛,不画。
   */
  open(extensionId: string, target: AppHostLayerTarget): void
  /**
   * 壳自己的点击(任务的链接、来源角标、通知):在这个 App 的面板上开这一个任务的对话,任务是壳自己认出来的那一条(与内置任务窗
   * 同一份 `AssistantTaskChat`),❌ App 递来的 id。壳此刻显示的不是这个账号 = 抛,不画。
   */
  openTask(extensionId: string, ownerId: string, request: AssistantTaskChat & { workId: string }): void
  /** 会话页:收起(给了 `kind` = 只在开着的是这一种时收起);没开着 = 什么都不变。 */
  close(extensionId: string, kind?: AppHostLayer['kind']): void
  getSnapshot(): AppHostLayers
  subscribe(listener: () => void): () => void
}

export const APP_HOST_LAYER_BRIDGE_KEY = '__GUGU_APP_HOST_LAYERS__' as const
type BridgeWindow = Window & { [APP_HOST_LAYER_BRIDGE_KEY]?: AppHostLayerBridge }

/** 壳读到的任务那一份:谁的、哪位助理的、每一行怎么打开(与内置列表点一行时同一个 `assistantPanelTaskChat`)。 */
type Rows = { ownerId: string; assistantId: string; open: (workId: string, sessionId: string) => (AssistantTaskChat & { workId: string }) | null }

const NONE: AppHostLayers = Object.freeze({})
let current: AppHostLayers = NONE
let account: string | null = null
let rows: Rows | null = null
const listeners = new Set<() => void>()

function publish(next: AppHostLayers): void {
  if (next === current) return
  current = Object.keys(next).length === 0 ? NONE : Object.freeze({ ...next })
  for (const listener of [...listeners]) listener()
}

function layerOf(target: AppHostLayerTarget): AppHostLayer {
  if (!account || account !== target.ownerId) throw new Error('This window does not show that account now')
  if (target.kind !== 'work') return { kind: target.kind, ownerId: target.ownerId }
  if (!rows || rows.ownerId !== target.ownerId) throw new Error('This window does not show that account\'s work now')
  const request = rows.open(target.workId, target.sessionId)
  if (!request) throw new Error('That task is not in the work list this window read')
  return { kind: 'work', ownerId: target.ownerId, request }
}

const bridge: AppHostLayerBridge = {
  open: (extensionId, target) => {
    publish({ ...current, [extensionId]: layerOf(target) })
  },
  openTask: (extensionId, ownerId, request) => {
    if (!account || account !== ownerId) throw new Error('This window does not show that account now')
    publish({ ...current, [extensionId]: { kind: 'work', ownerId, request } })
  },
  close: (extensionId, kind) => {
    const open = current[extensionId]
    if (!open || (kind && open.kind !== kind)) return
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
export function installAppHostLayerBridge(w: Window = window): void {
  const target = w as BridgeWindow
  if (target[APP_HOST_LAYER_BRIDGE_KEY] !== bridge) target[APP_HOST_LAYER_BRIDGE_KEY] = bridge
}

/** 会话页:读 window 上那一个桥;壳还没装上 = null。 */
export function readAppHostLayerBridge(w: Window | undefined = typeof window === 'undefined' ? undefined : window): AppHostLayerBridge | null {
  return w ? (w as BridgeWindow)[APP_HOST_LAYER_BRIDGE_KEY] ?? null : null
}

/** 壳:此刻登录的账号(null = 没登录):只给它开页。 */
export function setAppHostLayerAccount(ownerId: string | null): void {
  account = ownerId
}

/** 壳:此刻读到的任务那一份(null = 没在读:没登录、没有助理、没有 App 要);换了一份,开着的各自还留着,直到它自己的理由收起。 */
export function setAppWorkRows(next: Rows | null): void {
  rows = next
}

/** 壳:只留下 `keep` 说还能画的那几页(换了账号、离开会话页、App 停用 / 卸载 / 授权变了 → 当场收起)。 */
export function retainAppHostLayers(keep: (extensionId: string, layer: AppHostLayer) => boolean): void {
  const kept = Object.fromEntries(Object.entries(current).filter(([extensionId, layer]) => keep(extensionId, layer)))
  if (Object.keys(kept).length !== Object.keys(current).length) publish(kept)
}

/** 会话页在 App 面板里留给壳画那一页的格子(lib/shellSlots.ts 的公共格子表里的键)。 */
export const APP_HOST_LAYER_SLOT_PREFIX = 'app-host-layer:'
export const appHostLayerSlotKey = (extensionId: string) => `${APP_HOST_LAYER_SLOT_PREFIX}${extensionId}`

/** Tests only. */
export function resetAppHostLayersForTest(): void {
  rows = null
  account = null
  current = NONE
}
