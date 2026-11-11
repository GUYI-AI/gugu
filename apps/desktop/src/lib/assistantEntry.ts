// 入口切换(助理 App P5):人碰到个人助理的每一个入口 —— 最左栏顶上那一格、通知、聊天里的链接、通讯录 / 资料页打开它的私聊、
// 设置里那几条链接、快速聊天的「去主窗」、首次引导的「开通我的咕咕」、任务的链接、会议提醒 —— 都问这里**一个**判断。
// 助理的页面就是装好的「咕咕助理」App(它的页面摆在原生会话旁边,API 41 的那一框);内置的助理页已经没有了。
//
// 判据:登录的这个账号,主进程认过它装的是那个受信的官方 App(gugu-assistant:从市场装、签名的发行版、在 gugu 的市场仓、没用分叉;
// electron/.../assistant-app-entry.ts),并且开着 = 去 App。还用不了(正在装 = 栏顶那一格画「准备中」;装不上 = 统一报错出口说过一次;
// 人自己关掉了它):有助理 = 打开和它的私聊(同任何一条对话);还没有助理 = 「App」页上的那个 App(装上它 / 打开它:开通在 App 里,
// 设置里没有咕咕那一组,owner 11-12)。
// 它自己的几页(开通、资料、连接应用)也只在 App 里:画在 App 面板上的宿主层(openAssistantPageInApp)。
//
// 主进程那一句话(受不受信)由壳的 AssistantAppEntryHost 问来,挂在 window 上(形制同 assistantShellBridge:两棵树一份)。
import { useSyncExternalStore } from 'react'
import { appState } from '../session/renderer/lib/stores/app-state'
import { readAssistantShellBridge, type AssistantShellSnapshot } from './assistantShellBridge'
import { appConversationSlotKey, readAppConversationSurfaceBridge, type AppConversationSurfaces } from './appConversationSurfaceBridge'
import { appHostLayerSlotKey, readAppHostLayerBridge } from './appHostLayerBridge'
import { assistantLayerPage } from '../session/shared/extensions/app-host-layer'
import { setAppConversationPanelCollapsed } from '../session/renderer/features/apps/app-conversation-panel'
import type { AssistantTaskChat } from './assistantTaskChat'
import { openLinkTarget } from './guguLinks'
import { notify } from './notices'
import { platform } from '../platform'
import { UI_EVENTS } from './uiEvents'
import { installedExtensionsStore } from '../session/renderer/features/extensions/installed-extensions-store'
import { readsWork } from '../components/appSlot/appWorkLedger'

/** 产品自己的助理 App(GUYI-AI/gugu-assistant):两端同一个常量(assistant-entry.ts)。 */
import { ASSISTANT_APP_ID } from '../session/shared/extensions/assistant-entry'
import { requestAssistantSettingsSection, type AssistantSettingsSection } from './assistantSettingsSection'
export { ASSISTANT_APP_ID }

/** 主进程对这个账号说的:装着的是不是受信的那个 App(补装那一步还没装好时,栏顶那一格的「准备中」由壳的 rulesPending 画)。 */
export type AssistantAppWord = { ownerId: string; trusted: boolean }

export interface AssistantAppEntryBridge {
  getSnapshot(): AssistantAppWord | null
  subscribe(listener: () => void): () => void
}

export const ASSISTANT_APP_ENTRY_BRIDGE_KEY = '__GUGU_ASSISTANT_APP_ENTRY__' as const
type BridgeWindow = Window & { [ASSISTANT_APP_ENTRY_BRIDGE_KEY]?: AssistantAppEntryBridge }

let word: AssistantAppWord | null = null
const listeners = new Set<() => void>()
const bridge: AssistantAppEntryBridge = {
  getSnapshot: () => word,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** 壳:装桥(幂等)。 */
export function installAssistantAppEntryBridge(w: Window = window): void {
  const target = w as BridgeWindow
  if (target[ASSISTANT_APP_ENTRY_BRIDGE_KEY] !== bridge) target[ASSISTANT_APP_ENTRY_BRIDGE_KEY] = bridge
}

/** 壳:发布主进程那一句(没变不通知;null = 没登录 / 还没问到)。 */
export function publishAssistantAppWord(next: AssistantAppWord | null): void {
  if (word === next || (word && next && word.ownerId === next.ownerId && word.trusted === next.trusted)) return
  word = next
  for (const listener of listeners) listener()
}

export function readAssistantAppEntryBridge(w: Window | undefined = typeof window === 'undefined' ? undefined : window): AssistantAppEntryBridge | null {
  return w ? (w as BridgeWindow)[ASSISTANT_APP_ENTRY_BRIDGE_KEY] ?? null : null
}

/** 为什么要去它:`open` 打开它;`task-chat` 打开它派出的某个任务的对话(任务的链接、来源角标、通知),开在 App 面板上的宿主层里。 */
export type AssistantEntryPurpose = 'open' | 'task-chat'

/**
 * - `app`:去 App 自己那一页;`chatId` = 旁边此刻画着的就是和自己助理的那条私聊(null:没画,比如人在 App 的权限里选了别的)。
 * - `chat`:App 此刻用不了,和自己助理的那条私聊照任何一条对话打开。
 * - `setup`:还没有助理、也没有 App:开通在 App 里,所以去「App」页上的那个 App(装上 / 打开它;设置里没有咕咕那一组)。
 * - `wait`:还在读它是谁 / 读不到:不动。
 */
export type AssistantEntryTarget =
  | { kind: 'app'; extensionId: typeof ASSISTANT_APP_ID; chatId: string | null }
  | { kind: 'chat'; chatId: string }
  | { kind: 'setup' }
  | { kind: 'wait' }
const WAIT: AssistantEntryTarget = Object.freeze({ kind: 'wait' })
const SETUP: AssistantEntryTarget = Object.freeze({ kind: 'setup' })

/** 唯一的判断。 */
export function decideAssistantEntry(input: {
  shell: Pick<AssistantShellSnapshot, 'assistantState' | 'chatId' | 'ownerId'> | null
  word: AssistantAppWord | null
  surfaces: AppConversationSurfaces
  /** 人有没有把那个 App 关掉(关掉 = 它的页不画,当它此刻用不了)。 */
  appEnabled: boolean
}): AssistantEntryTarget {
  const { shell, word, surfaces } = input
  const ownerId = shell?.ownerId ?? null
  if (!ownerId) return WAIT
  const chatId = shell?.assistantState === 'found' ? shell.chatId : null
  if (word && word.ownerId === ownerId && word.trusted && input.appEnabled) {
    return { kind: 'app', extensionId: ASSISTANT_APP_ID, chatId: chatId && surfaces[ASSISTANT_APP_ID] === chatId ? chatId : null }
  }
  if (chatId) return { kind: 'chat', chatId }
  return shell?.assistantState === 'none' ? SETUP : WAIT
}

const NO_SURFACES: AppConversationSurfaces = Object.freeze({})

function appReadsWork(): boolean {
  const manifest = installedExtensionsStore.manifestFor(ASSISTANT_APP_ID)
  return !!manifest && readsWork(manifest)
}

/** 此刻的判断(读三座桥:壳的助理快照、旁边画着哪条会话、主进程那一句;再加上人有没有关掉那个 App)。 */
export function readAssistantEntryTarget(): AssistantEntryTarget {
  return decideAssistantEntry({
    shell: readAssistantShellBridge()?.getSnapshot() ?? null,
    word: readAssistantAppEntryBridge()?.getSnapshot() ?? null,
    surfaces: readAppConversationSurfaceBridge()?.getSnapshot() ?? NO_SURFACES,
    appEnabled: !!installedExtensionsStore.manifestFor(ASSISTANT_APP_ID) && installedExtensionsStore.isEnabled(ASSISTANT_APP_ID),
  })
}

/**
 * Whether the App is where the entry goes right now. False = it is not usable here (switched off by the person, still being put
 * in, failing to go in): every route to the assistant is then its chat as any chat, and a task it started is an ordinary task.
 */
export function assistantAppUsable(): boolean {
  return readAssistantEntryTarget().kind === 'app'
}

function subscribeAll(listener: () => void): () => void {
  const offs = [readAssistantShellBridge(), readAppConversationSurfaceBridge(), readAssistantAppEntryBridge()]
    .map((source) => source?.subscribe(listener) ?? (() => undefined))
  return () => offs.forEach((off) => off())
}

/** 同一个判断,跟着三座桥变(左栏那一格画哪种、亮不亮)。 */
export function useAssistantEntryTarget(): AssistantEntryTarget {
  const key = useSyncExternalStore(subscribeAll, () => JSON.stringify(readAssistantEntryTarget()))
  return JSON.parse(key) as AssistantEntryTarget
}

/**
 * 去 App 时栏顶那一格的未读点:就读那条私聊自己的未读(同 dock 上 App 的点,#1930 一个来源,❌ 另记一份);读不到 / 数不对 = null,
 * ❌ 当成「没有未读」。
 */
export function assistantEntryUnread(chats: readonly { id: string; unread_count: number }[], chatId: string): boolean | null {
  const chat = chats.find((candidate) => candidate.id === chatId)
  if (!chat || !Number.isFinite(chat.unread_count) || chat.unread_count < 0) return null
  return chat.unread_count > 0
}

/**
 * 去 App 自己那一页(它的页面摆在会话旁边;已经在那一页就不动它)。答那条会话在哪一格画(问文件、跳到某条消息都落在那一格)。
 * 只是去那里:❌ 标已读 —— 已读只由那一列会话真的摆在眼前时确认(AppConversationSurfaceHost),与内置页同一条。
 */
export function openAssistantApp(target: Extract<AssistantEntryTarget, { kind: 'app' }>): string {
  const navigation = appState.navigation
  if (navigation.currentViewId !== 'app' || navigation.viewParamsStore.app?.appId !== target.extensionId || navigation.viewParamsStore.app?.tab) {
    navigation.navigate('app', { appId: target.extensionId })
  }
  return appConversationSlotKey(target.extensionId)
}

/**
 * 每个入口都走这一下。去 App:答那条会话(或任务的对话)画在哪一格。App 此刻用不了:`fallback` 时打开和自己助理的私聊
 * (照任何一条对话,经链接那条路);还没有助理 = 「App」页上的那个 App;答 null。`fallback: false` = 调用处自己打开那条对话(链接、通知)。
 */
export function openAssistantEntry(purpose: AssistantEntryPurpose = 'open', fallback = true): string | null {
  const target = readAssistantEntryTarget()
  if (target.kind === 'app') {
    const conversation = openAssistantApp(target)
    return purpose === 'task-chat' ? appHostLayerSlotKey(target.extensionId) : target.chatId ? conversation : null
  }
  if (!fallback) return null
  if (target.kind === 'chat') void openLinkTarget({ kind: 'chat', chatId: target.chatId }).catch(() => undefined)
  else if (target.kind === 'setup') openAssistantAppToInstall()
  return null
}

/**
 * No assistant and no App where it lives (not installed, switched off, a copy main does not trust): a 开通 the shell still
 * asks for (an entry, a reminder, an old 资料 route) opens the Apps page on the assistant App — its market page to install it,
 * or its own page to switch it on — since setting it up is in the App (owner 11-12), never nothing. Only where Apps are
 * (a task host): the web build has no Apps page. A refused link (that App gone from the market) is said once.
 */
function openAssistantAppToInstall(): boolean {
  if (!platform.capabilities.sessionHost) return false
  window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
  void openLinkTarget({ kind: 'app-detail', extensionId: ASSISTANT_APP_ID })
    .catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
  return true
}

/**
 * The person's own connected apps (not the assistant's): on a computer their home is the Library's 集成 (the phone, which has
 * no Library, has a row in Settings). Where a route to them has no assistant App to land in, it lands there.
 */
function openOwnConnections(): boolean {
  if (!platform.capabilities.sessionHost) return false
  window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
  appState.navigation.navigate('library', { tab: 'integrations' })
  return true
}

/** The assistant's own pages a route of the shell's names (what Settings' 咕咕 group held): its setup or settings, its connected apps. */
export type AssistantInAppPage = 'settings' | 'connected-apps'

/**
 * Every route of the shell's own that used to open Settings' 咕咕 group (its 资料, its 连接应用: a notification, a connection
 * prompt, an old section link) lands here: the App's page, with that page of the assistant drawn over its panel (the host
 * layer, as the App's own `gugu.assistant.open` draws it). With no assistant yet, 资料 is setting it up (from the name: the
 * App's intro is its first screen); its connected apps wait for it (the App's page alone). App not usable now: its chat as
 * any chat (D9/D10); with no assistant either, 资料 opens the Apps page on the App (to install or switch it on) and the connected
 * apps the person's own on the Library's 集成 (no Settings group to fall back on). Answers whether it went anywhere.
 * `section`: a part of the settings page to open at (its model), only when that page is the one drawn.
 */
export function openAssistantPageInApp(page: AssistantInAppPage, section?: AssistantSettingsSection): boolean {
  const target = readAssistantEntryTarget()
  if (target.kind === 'chat') {
    void openLinkTarget({ kind: 'chat', chatId: target.chatId }).catch(() => undefined)
    return true
  }
  // No assistant and no App: 资料 is 开通, which is the App's to do; the connected apps are the person's own.
  if (target.kind === 'setup') return page === 'settings' ? openAssistantAppToInstall() : openOwnConnections()
  if (target.kind !== 'app') return false
  const shell = readAssistantShellBridge()?.getSnapshot()
  const ownerId = shell?.ownerId
  if (!ownerId) return false
  const found = shell.assistantState === 'found' && !!shell.assistant
  window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
  openAssistantApp(target)
  // Still finding it (being read, unreadable): the App's page says so; nothing over it.
  if (!found && shell.assistantState !== 'none') return true
  if (!found && page === 'connected-apps') return true
  const kind = assistantLayerPage(page === 'settings' ? 'setup' : page, found)
  // Beside its conversation the panel may be folded away: the page is drawn there, so it opens.
  setAppConversationPanelCollapsed(target.extensionId, false)
  // The bridge refuses an account this window no longer shows: then the App's page alone, as for any other entry.
  const bridge = readAppHostLayerBridge()
  if (section && kind === 'assistant-settings' && bridge) requestAssistantSettingsSection(section)
  try {
    bridge?.open(target.extensionId, { kind, ownerId })
  } catch {
    // The App's page is on screen; nothing over it.
    if (section) requestAssistantSettingsSection(null)
  }
  return true
}

/**
 * 壳认出的一个任务(带它在活里的 id),去 App:App 自己那一页,任务的对话开在它面板上的宿主层(同原来的任务窗)。App 此刻用不了 =
 * null。壳此刻显示的不是这个账号、App 读不到它的活 = 抛(调用处走统一的报错出口)。
 */
export function openAssistantTaskInApp(ownerId: string, request: AssistantTaskChat & { workId: string }): string | null {
  const target = readAssistantEntryTarget()
  if (target.kind !== 'app') return null
  const bridge = readAppHostLayerBridge()
  if (!bridge) return null
  if (!appReadsWork()) throw new Error('The assistant App does not read its work')
  openAssistantApp(target)
  bridge.openTask(target.extensionId, ownerId, request)
  return appHostLayerSlotKey(target.extensionId)
}
