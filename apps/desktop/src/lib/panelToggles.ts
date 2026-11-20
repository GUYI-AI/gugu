import { useSyncExternalStore } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

/**
 * @@@panel-toggles (#6753) — 列表栏开关的唯一控制器。
 *
 *   收放会话页的列表栏和内层栏(#2548,打开一个群 / 项目时列表右边那一列)。
 *
 * 面板由各页自己登记进来;按钮(PanelToggleButtons.tsx,各处挂的是同一个组件)、Windows 标题栏的「视图」菜单、
 * 快捷键都只经这里下命令 ⇒ 每颗按钮只有一个坐标,❌ 各页再各长一颗(#5454)。
 * 会话页是同一文档里另一份模块(sessionpageHistoryBridge.ts 同一理由),所以这张表挂在 window 上,两边读写同一份;
 * 文案也由登记方给,按钮本身不碰哪一边的词表。
 */
export type PanelSlot = 'list:sessions' | 'column:inner'

export interface PanelToggle {
  open: boolean
  /** 按钮此刻的名字(收起 / 展开…),已本地化。 */
  label: string
  /** 收起态悬停浮出的预览。浮着时再点 = 钉住,❌ 再放一次展开动画。 */
  peeking?: boolean
  toggle: () => void
  /** 开关钮把悬停报给面板:悬停意图成立才浮出预览。 */
  setTriggerHovered?: (hovered: boolean) => void
  /** 提示里显示的快捷键(已按平台格式化)。 */
  shortcut?: string
}

const REGISTRY_KEY = '__GUGU_PANEL_TOGGLES__'

interface Registry {
  slots: Map<PanelSlot, PanelToggle>
  listeners: Set<() => void>
}

function registry(): Registry {
  const w = window as unknown as { [REGISTRY_KEY]?: Registry }
  return (w[REGISTRY_KEY] ??= { slots: new Map(), listeners: new Set() })
}

function notify(r: Registry): void {
  for (const listener of r.listeners) listener()
}

/** 登记(或更新)一格。返回的撤销只撤自己这一份:后登记的那份不会被先卸载的撤掉。 */
export function publishPanelToggle(slot: PanelSlot, toggle: PanelToggle): () => void {
  const r = registry()
  r.slots.set(slot, toggle)
  notify(r)
  return () => {
    if (r.slots.get(slot) !== toggle) return
    r.slots.delete(slot)
    notify(r)
  }
}

export function readPanelToggle(slot: PanelSlot | null): PanelToggle | null {
  return slot ? registry().slots.get(slot) ?? null : null
}

function subscribe(listener: () => void): () => void {
  const r = registry()
  r.listeners.add(listener)
  return () => r.listeners.delete(listener)
}

export function usePanelToggle(slot: PanelSlot | null): PanelToggle | null {
  return useSyncExternalStore(subscribe, () => readPanelToggle(slot), () => null)
}

/** 这一页签的列表栏。通讯录的导航列定宽、不可拖,与会话列表不同构 ⇒ 没有(开关画成禁用占位)。 */
export function listSlotOf(tab: SidebarTab): PanelSlot | null {
  if (tab === 'tasks') return 'list:sessions'
  return null
}
