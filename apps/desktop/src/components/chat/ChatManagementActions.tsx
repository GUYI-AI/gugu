import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { ChatNotificationLevelControl } from './ChatNotificationLevelControl'
import { COLOR_MUTED } from './chatPresentation'
import { rendererLogger } from '../../lib/log'

const managementLog = rendererLogger('chat/management-actions')

// @@@6418 会话管理动作(通知 / 置顶 / 清空;查找聊天记录只在页头「…」里,❌ 这里再放一份)。单聊和群聊的设置抽屉共用这一份 ——
// 从 ChatAreaPanel 搬出来,群设置不再是「单聊有、群聊没有」。
export interface ChatManagementActionsProps {
  activeChat: ChatItem
  onClose: () => void
  onClearMessages: () => Promise<void>
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  /**
   * drawer = 单聊抽屉原样(行距 10、分隔线);settings = 嵌在群聊设置页里,
   * 与该页其它行同一套几何(13px 行距、整行 hover、无分隔线、行尾 chevron)—— 同一页里❌ 两种节奏。
   */
  appearance?: 'drawer' | 'settings'
  /** 画在「清空聊天记录」前面(群设置页:它和离开 / 解散是最底下的一组,这里给那一组的小标题)。 */
  beforeClear?: ReactNode
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  cursor: 'pointer',
  fontSize: 'var(--font-body)',
  color: 'var(--text-primary)',
}
const STATIC_ROW_STYLE: CSSProperties = { ...ROW_STYLE, cursor: 'default' }
const DANGER_ROW_STYLE: CSSProperties = { ...ROW_STYLE, color: 'var(--danger-fg)' }
const DIVIDER_STYLE: CSSProperties = { height: '1px', background: 'var(--border-color)', flexShrink: 0 }
const COLUMN_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column' }
const ERROR_STYLE: CSSProperties = {
  margin: '8px 14px 0', padding: '7px 8px', borderRadius: 'var(--radius-document)',
  background: 'var(--danger-tint)', color: 'var(--danger-fg)', fontSize: 'var(--font-caption)', lineHeight: '15px',
}
const CONFIRM_STYLE: CSSProperties = { padding: '10px 14px' }
const CONFIRM_TEXT_STYLE: CSSProperties = { fontSize: 'var(--font-body)', color: COLOR_MUTED, margin: '0 0 8px' }
const CONFIRM_ACTIONS_STYLE: CSSProperties = { display: 'flex', gap: '8px' }
const CONFIRM_BUTTON_STYLE: CSSProperties = { flex: 1 }
const SETTINGS_ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
  margin: '0 -8px', padding: '13px 8px', borderRadius: 'var(--radius-control)', cursor: 'pointer',
  fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)',
}
// 通知档位那一行:三段控件不收缩,标签 + 控件放不进一行(英文、窄抽屉)时控件整块换到下一行、仍贴右 ——
// ❌ 撑宽这一行,那会让外层滚动容器出横向滚动条。标签的 auto 右边距在一行时把控件推到行尾。
const WRAP_ROW: CSSProperties = { flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 16, rowGap: 8 }
const WRAP_ROW_LABEL_STYLE: CSSProperties = { marginRight: 'auto' }
const APPEARANCE = {
  drawer: {
    staticRow: STATIC_ROW_STYLE,
    wrapRow: { ...STATIC_ROW_STYLE, ...WRAP_ROW } as CSSProperties,
    dangerRow: DANGER_ROW_STYLE,
    divider: DIVIDER_STYLE as CSSProperties | null,
    confirm: CONFIRM_STYLE,
    error: ERROR_STYLE,
  },
  settings: {
    staticRow: { ...SETTINGS_ROW_STYLE, cursor: 'default' } as CSSProperties,
    wrapRow: { ...SETTINGS_ROW_STYLE, cursor: 'default', ...WRAP_ROW } as CSSProperties,
    dangerRow: { ...SETTINGS_ROW_STYLE, color: 'var(--danger-fg)' } as CSSProperties,
    divider: null as CSSProperties | null,
    confirm: { padding: '10px 0' } as CSSProperties,
    error: { ...ERROR_STYLE, margin: '8px 0 0' } as CSSProperties,
  },
}

export function ChatManagementActions({ activeChat, onClose, onClearMessages, onSetNotificationLevel, onTogglePinned, appearance = 'drawer', beforeClear }: ChatManagementActionsProps) {
  const { t } = useTranslation('messaging')
  const look = APPEARANCE[appearance]
  const [confirmClear, setConfirmClear] = useState(false)
  const [settingNotificationLevel, setSettingNotificationLevel] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const notificationLevel = activeChat.notification_level ?? 'all'

  useEffect(() => {
    setActionError(null)
    setConfirmClear(false)
  }, [activeChat.id])

  return (
    <div style={COLUMN_STYLE}>
      {actionError ? <div style={look.error}>{actionError}</div> : null}
      <div style={look.wrapRow}>
        <span style={WRAP_ROW_LABEL_STYLE}>{t('chatArea.management.notifications')}</span>
        <ChatNotificationLevelControl
          value={notificationLevel}
          busy={settingNotificationLevel}
          onSelect={(level) => {
            if (level === notificationLevel) return
            setSettingNotificationLevel(true)
            setActionError(null)
            onSetNotificationLevel(level)
              .catch((err) => {
                const message = String((err as Error)?.message ?? err)
                setActionError(t('chatArea.management.notificationFailed', { reason: message }))
                managementLog.error({ error: err, chatId: activeChat.id, level }, 'set notification level failed')
              })
              .finally(() => setSettingNotificationLevel(false))
          }}
        />
      </div>
      <div style={look.staticRow}>
        <span>{t('chatArea.management.pin')}</span>
        {/* @@@3079 Switch 原语:同一套 --switch-* token、hover/focus-visible/disabled 齐全、
            prefers-reduced-motion 下自动静止。 */}
        <Switch
          data-testid={AUTOMATION_TEST_IDS.chatDrawerPinSwitch}
          aria-label={activeChat.is_pinned ? t('chatArea.management.unpin') : t('chatArea.management.pin')}
          disabled={pinning}
          checked={Boolean(activeChat.is_pinned)}
          onCheckedChange={(next) => {
            setPinning(true)
            setActionError(null)
            onTogglePinned(next)
              .catch((err) => {
                const message = String((err as Error)?.message ?? err)
                setActionError(t('chatArea.management.pinFailed', { reason: message }))
                managementLog.error({ error: err, chatId: activeChat.id, pinned: next }, 'pin chat failed')
              })
              .finally(() => setPinning(false))
          }}
        />
      </div>
      {look.divider ? <div style={look.divider} /> : null}
      {beforeClear}
      {!confirmClear ? (
        <div className="gg-row" style={look.dangerRow} onClick={() => setConfirmClear(true)}>
          {t('chatArea.management.clearHistory')}
        </div>
      ) : (
        <div style={look.confirm}>
          <p style={CONFIRM_TEXT_STYLE}>{t('chatArea.management.clearConfirm')}</p>
          <div style={CONFIRM_ACTIONS_STYLE}>
            <Button
              variant="danger"
              size="sm"
              style={CONFIRM_BUTTON_STYLE}
              onClick={() => {
                onClearMessages()
                  .then(() => {
                    setConfirmClear(false)
                    onClose()
                  })
                  .catch((err) => {
                    const message = String((err as Error)?.message ?? err)
                    setActionError(t('chatArea.management.actionFailed', { action: t('chatArea.management.clearHistory'), reason: message }))
                    managementLog.error({ error: err, chatId: activeChat.id }, 'clear messages failed')
                  })
              }}
            >
              {t('chatArea.management.clear')}
            </Button>
            <Button variant="secondary" size="sm" style={CONFIRM_BUTTON_STYLE} onClick={() => setConfirmClear(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
