import { NAV_COLUMN_MAX_WIDTH, NAV_COLUMN_MIN_WIDTH, NAV_COLUMN_WIDTH } from '@/lib/uiRuler'
import { clampPaneWidth, definePaneWidth, readPaneWidth, writePaneWidth } from '@/lib/paneWidth'

// @@@ui-ruler 会话列表默认宽 = 通讯录导航列宽(--nav-col-w):切 tab 时分隔线不再左右跳。
export const CHAT_LIST_PANE_DEFAULT_WIDTH = NAV_COLUMN_WIDTH
export const CHAT_LIST_PANE_MIN_WIDTH = NAV_COLUMN_MIN_WIDTH
export const CHAT_LIST_PANE_MAX_WIDTH = NAV_COLUMN_MAX_WIDTH
export const CHAT_CONTENT_WITH_RIGHT_PANEL_MIN_WIDTH = 740

const CHAT_LIST_PANE = definePaneWidth({ id: 'gugu.chatListPane.width', initial: CHAT_LIST_PANE_DEFAULT_WIDTH, min: CHAT_LIST_PANE_MIN_WIDTH, max: CHAT_LIST_PANE_MAX_WIDTH })

export const clampChatListPaneWidth = (width: number): number => clampPaneWidth(CHAT_LIST_PANE, width)

export function maxChatListPaneWidthForAvailableWidth(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return CHAT_LIST_PANE_MAX_WIDTH
  const remaining = Math.floor(availableWidth - CHAT_CONTENT_WITH_RIGHT_PANEL_MIN_WIDTH)
  return Math.min(CHAT_LIST_PANE_MAX_WIDTH, Math.max(CHAT_LIST_PANE_MIN_WIDTH, remaining))
}

export const readStoredChatListPaneWidth = (): number => readPaneWidth(CHAT_LIST_PANE)
export const writeStoredChatListPaneWidth = (width: number): void => writePaneWidth(CHAT_LIST_PANE, width)
