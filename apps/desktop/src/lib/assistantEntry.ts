// 入口切换(助理 App P5):人碰到个人助理的每一个入口 —— 最左栏顶上那一格、通知、聊天里的链接、通讯录 / 资料页打开它的私聊、
// 设置里那几条链接、快速聊天的「去主窗」、首次引导的「开通我的咕咕」—— 都问这里**一个**判断:去装好的「咕咕助理」App
// (它的页面摆在原生会话旁边,API 41 的那一框),还是内置的助理页。
//
// 判据:登录的这个账号,主进程认过它装的是那个受信的官方 App(gugu-assistant:从市场装、代码在 gugu 的市场仓、没用分叉;
// electron/.../assistant-app-entry.ts),而且那个 App 的会话绑定此刻画在旁边的,正是和自己助理的那条私聊
// (壳的 AppConversationSurfaceHost 认过:账号、启用、授权、仍在会话里)。差一样 = 内置页,照旧。
// 两条路都留着、都能测;内置页整页删掉是之后单独一个提交的事。
//
// 主进程那一句话(受不受信、市场那一步是不是正在装)由壳的 AssistantAppEntryHost 问来,挂在 window 上(形制同
// assistantShellBridge:两棵树一份)。
import { useSyncExternalStore } from 'react'
import { appState } from '../session/renderer/lib/stores/app-state'
import { readAssistantShellBridge, type AssistantShellSnapshot } from './assistantShellBridge'
import { appConversationSlotKey, readAppConversationSurfaceBridge, type AppConversationSurfaces } from './appConversationSurfaceBridge'

/** 产品自己的助理 App(GUYI-AI/gugu-assistant;主进程同名常量 ASSISTANT_APP_ID)。 */
export const ASSISTANT_APP_ID = 'gugu-assistant'

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

/**
 * 为什么要去它:`open` 打开它(栏顶那一格、通知、链接、设置、快速聊天、引导)。另两种此刻还只有内置页做得到,照旧去内置页:
 * `task-chat` 打开它派出的某个任务的对话(内置面板的「任务」;App 里打开要 App 自己按 API 46 的 openWork 拿句柄);
 * `record-meeting` 会议提醒里「开始录音」(录音机由内置页挂上,API 47 的 App 录音宿主合进来之前,别处起不来)。
 */
export type AssistantEntryPurpose = 'open' | 'task-chat' | 'record-meeting'

export type AssistantEntryTarget = { kind: 'app'; extensionId: typeof ASSISTANT_APP_ID; chatId: string } | { kind: 'built-in' }
const BUILT_IN: AssistantEntryTarget = Object.freeze({ kind: 'built-in' })

/** 唯一的判断。 */
export function decideAssistantEntry(input: {
  shell: Pick<AssistantShellSnapshot, 'assistantState' | 'chatId' | 'ownerId'> | null
  word: AssistantAppWord | null
  surfaces: AppConversationSurfaces
  purpose?: AssistantEntryPurpose
}): AssistantEntryTarget {
  const { shell, word, surfaces, purpose = 'open' } = input
  if (purpose !== 'open') return BUILT_IN
  const ownerId = shell?.ownerId ?? null
  if (!ownerId || !word || word.ownerId !== ownerId || !word.trusted) return BUILT_IN
  if (shell?.assistantState !== 'found' || !shell.chatId) return BUILT_IN
  return surfaces[ASSISTANT_APP_ID] === shell.chatId ? { kind: 'app', extensionId: ASSISTANT_APP_ID, chatId: shell.chatId } : BUILT_IN
}

const NO_SURFACES: AppConversationSurfaces = Object.freeze({})

/** 此刻的判断(读三座桥:壳的助理快照、旁边画着哪条会话、主进程那一句)。 */
export function readAssistantEntryTarget(purpose: AssistantEntryPurpose = 'open'): AssistantEntryTarget {
  return decideAssistantEntry({
    shell: readAssistantShellBridge()?.getSnapshot() ?? null,
    word: readAssistantAppEntryBridge()?.getSnapshot() ?? null,
    surfaces: readAppConversationSurfaceBridge()?.getSnapshot() ?? NO_SURFACES,
    purpose,
  })
}

function subscribeAll(listener: () => void): () => void {
  const offs = [readAssistantShellBridge(), readAppConversationSurfaceBridge(), readAssistantAppEntryBridge()]
    .map((source) => source?.subscribe(listener) ?? (() => undefined))
  return () => offs.forEach((off) => off())
}

/** 同一个判断,跟着三座桥变(左栏那一格画哪种、亮不亮)。 */
export function useAssistantEntryTarget(): AssistantEntryTarget {
  const key = useSyncExternalStore(subscribeAll, () => {
    const target = readAssistantEntryTarget()
    return target.kind === 'app' ? target.chatId : ''
  })
  return key ? { kind: 'app', extensionId: ASSISTANT_APP_ID, chatId: key } : BUILT_IN
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
 * 每个入口都走这一下:判断去 App,就去 App;否则照它原来那样去内置页(`builtIn`,每处原样不动)。
 */
export function openAssistantEntry<T>(builtIn: () => T, purpose: AssistantEntryPurpose = 'open'): T | string {
  const target = readAssistantEntryTarget(purpose)
  return target.kind === 'app' ? openAssistantApp(target) : builtIn()
}
