import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CSSProperties, ReactNode } from 'react'
import { useMobileShell } from '../../hooks/useMobileShell'
import type { ChatItem, GroupCollabSnapshot, NotificationLevel } from '@gugu/core/shared/types/chat'
import { GroupFolderRow, GroupMembersRow } from './GroupInfoRows'
import { GroupNameRow } from './GroupNameRow'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { buildUnifiedMembers } from './groupMemberModels'
import { chatService } from '../../lib/chat'
import { GroupAvatarEditor } from './GroupAvatarEditor'
import { useGroupAvatarUpload } from './useGroupAvatarUpload'
import { ChatManagementActions } from './ChatManagementActions'
import { GroupSettingsManagePage } from './GroupSettingsManagePage'
import { MemberListPanel, type MemberListPanelProps } from './MemberListPanel'
import { AnnouncementDrawer } from './AnnouncementDrawer'
import { groupRoleRevision, useGroupChatSettings, type GroupChatSettingsState } from './useGroupChatSettings'
import { useSettingsPages } from './useSettingsPages'
import { SettingsNavRow, SettingsPageFrame, SettingsPageHead } from './groupSettingsUi'
import {
  settingsBodyStyle,
  settingsErrorStyle,
  settingsMobileBodyStyle,
  settingsReadOnlyBoxStyle,
  settingsSectionLabelStyle,
  settingsTextareaStyle,
} from './groupSettingsStyles'

// @@@6418 群聊设置 = 一个页面栈(useSettingsPages):成员、公告、群管理、规则、描述各是一页。

const profileRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }
const avatarFrameStyle: CSSProperties = {
  position: 'relative', width: 52, height: 52, borderRadius: 'var(--radius-2xl)', overflow: 'hidden', flexShrink: 0,
  background: 'transparent', display: 'grid', placeItems: 'center', cursor: 'default',
}
const avatarFrameEditableStyle: CSSProperties = { ...avatarFrameStyle, cursor: 'pointer' }
const avatarFrameDragStyle: CSSProperties = { ...avatarFrameEditableStyle, border: '1px dashed var(--primary)' }
const avatarUploadingStyle: CSSProperties = {
  position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--bg-overlay-modal)',
  color: 'var(--color-white)', fontSize: 'var(--font-caption)',
}
const profileTextStyle: CSSProperties = { flex: 1, minWidth: 0 }
const memberCountStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--muted-fg)', marginTop: 3 }
const leaveStyle: CSSProperties = {
  marginTop: 20, textAlign: 'center', color: 'var(--danger-fg)', fontSize: 'var(--font-body)', fontWeight: 500,
  cursor: 'pointer', padding: 11, borderRadius: 'var(--radius-xl)', background: 'var(--danger-tint)',
}
const confirmStyle: CSSProperties = { marginTop: 20 }
const confirmTextStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-secondary)', margin: '0 0 8px' }
const confirmActionsStyle: CSSProperties = { display: 'flex', gap: 8 }
const confirmButtonStyle: CSSProperties = { flex: 1 }

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split('\n').find((part) => part.trim())
  return line?.trim() || null
}

export function GroupMembersSection({
  chat,
  initialPage,
  snapshot,
  snapshotError,
  settingsState,
  currentUserId,
  onReload,
  onClose,
  onLeaveGroup,
  onDissolveGroup,
  onOpenUserChat,
  onWhisper,
  onSetNotificationLevel,
  onTogglePinned,
  onClearMessages,
}: {
  chat: ChatItem
  /** Opened at the members' list or the announcement (the info tab's members button): no way back into the first page. */
  initialPage?: 'main' | 'members' | 'announcement'
  snapshot: GroupCollabSnapshot
  settingsState?: GroupChatSettingsState
  snapshotError?: MemberListPanelProps['error']
  currentUserId: string | null
  onReload: () => Promise<void>
  onClose: () => void
  /** 可能是 async —— await 它,失败才进得了错误行(#1730)。缺省走 chatService.removeGroupMember。 */
  onLeaveGroup?: () => void | Promise<void>
  /** 群主解散;同样 await(#1731)。 */
  onDissolveGroup?: () => void | Promise<void>
  onOpenUserChat?: MemberListPanelProps['onOpenUserChat']
  onWhisper?: MemberListPanelProps['onWhisper']
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  onClearMessages: () => Promise<void>
}) {
  const chatId = chat.id
  const { t } = useTranslation('messaging')
  const mobileShell = useMobileShell()
  const { page, push, pop, canPop } = useSettingsPages(chatId, initialPage)

  const ownSettings = useGroupChatSettings(settingsState ? null : chatId, groupRoleRevision(snapshot))
  const { settings, error: settingsError, setError: setSettingsError, update, setAvatarUrl } = settingsState ?? ownSettings
  // A shared hook outlives this panel: opening the panel reads again (ownSettings has just read on its own mount).
  const reloadShared = settingsState?.reload
  useEffect(() => { reloadShared?.() }, [reloadShared])
  const viewerRole = settings?.my_role ?? null
  const viewerIsManager = settings?.can_manage === true

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmExit, setConfirmExit] = useState(false)
  const { avatarUploading, handleAvatarFile, handleAvatarReset } = useGroupAvatarUpload({ chatId, viewerIsManager, setAvatarUrl, setActionError })
  const [avatarDragOver, setAvatarDragOver] = useState(false)
  const [avatarEditing, setAvatarEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // 成员行的「+」:进成员页时选人页已经开着(成员页自己那一个)。
  const [inviting, setInviting] = useState(false)
  const openMembers = (invite: boolean) => { setInviting(invite); push('members') }

  const unifiedMembers = useMemo(() => buildUnifiedMembers(snapshot), [snapshot])
  const totalMembers = snapshot.humans.length + snapshot.agents.length

  // @@@2070 群名就地编辑:只写 name。写失败要抛给 GroupNameInlineEdit —— 它据此留在编辑态并标出失败,
  // ❌ 当作改好了把输入框关掉(原因已由 update 放进错误行)。
  const handleRename = useCallback(async (next: string) => {
    if (!(await update({ name: next }))) throw new Error('group rename failed')
  }, [update])

  // #1730/#1731 离开/解散都 await 回调,失败进错误行;busy 防双击并发。确认改为抽屉内确认(与单聊清空同一形态)。
  const handleExit = useCallback(async () => {
    if (busy || !currentUserId || !settings) return
    setBusy(true)
    setActionError(null)
    try {
      if (viewerRole === 'owner') {
        await onDissolveGroup?.()
      } else if (onLeaveGroup) {
        await onLeaveGroup()
      } else {
        await chatService.removeGroupMember(chatId, currentUserId)
        await onReload()
      }
      setConfirmExit(false)
    } catch (err) {
      setActionError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [busy, chatId, currentUserId, onDissolveGroup, onLeaveGroup, onReload, settings, viewerRole])

  const openTextPage = useCallback((next: 'rules' | 'description') => {
    // 设置还没读到时不进编辑页:草稿会从空串起步,点「完成」就把库里原有的规则/描述清掉。
    if (!settings) return
    setSettingsError(null)
    setDraft((next === 'rules' ? settings.group_prompt : settings.description) ?? '')
    push(next)
  }, [push, setSettingsError, settings])

  const saveTextPage = useCallback(async () => {
    const value = draft.trim() || null
    const ok = await update(page === 'rules' ? { group_prompt: value } : { description: value })
    if (ok) pop()
  }, [draft, page, pop, update])

  const error = actionError ?? settingsError
  const errorLine = error ? <div role="alert" style={settingsErrorStyle}>{error}</div> : null
  const bodyStyle = mobileShell ? settingsMobileBodyStyle : settingsBodyStyle
  const canExit = !!settings && (viewerRole !== 'owner' || Boolean(onDissolveGroup))
  const groupName = settings?.name ?? chat.name ?? null

  const subHead = (title: ReactNode, action?: ReactNode) => <SettingsPageHead title={title} action={action} onBack={canPop ? pop : undefined} onClose={mobileShell ? onClose : undefined} mobile={mobileShell} />
  let content: ReactNode
  if (page === 'members') {
    content = <MemberListPanel settingsState={settingsState ?? ownSettings} chatId={chatId} chatKind="group" invite={inviting} snapshot={snapshot} error={snapshotError} onReload={onReload} onOpenUserChat={onOpenUserChat} onWhisper={onWhisper} head={subHead} />
  } else if (page === 'announcement') {
    content = <AnnouncementDrawer chatId={chatId} isAdmin={viewerIsManager} head={subHead} />
  } else if (page === 'manage' && settings) {
    content = (
      <>
        {subHead(t('group.settings.manage'))}
        <div style={bodyStyle}>
          <GroupSettingsManagePage
            chatId={chatId}
            settings={settings}
            totalMembers={totalMembers}
            onUpdate={update}
          />
          {errorLine}
        </div>
      </>
    )
  } else if (page === 'rules' || page === 'description') {
    const isRules = page === 'rules'
    const saved = isRules ? settings?.group_prompt : settings?.description
    content = (
      <>
        {subHead(isRules ? t('group.settings.rules') : t('group.settings.description'),
          viewerIsManager ? <Button variant="primary" size="sm" onClick={() => { void saveTextPage() }}>{t('common.done')}</Button> : undefined)}
        <div style={bodyStyle}>
          {viewerIsManager ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={isRules ? t('group.settings.rulesPlaceholder') : t('group.settings.descriptionPlaceholder')}
              aria-label={isRules ? t('group.settings.rules') : t('group.settings.description')}
              style={settingsTextareaStyle}
            />
          ) : (
            <div style={settingsReadOnlyBoxStyle}>
              {saved || (isRules ? t('group.settings.rulesUnset') : t('group.settings.descriptionUnset'))}
            </div>
          )}
          {errorLine}
        </div>
      </>
    )
  } else {
    content = (
      <>
        {/* 桌面上群信息是一枚页签:它自己就是标题和 ×,只有二级页画返回;手机整页照旧左上返回 = 关。 */}
        {mobileShell ? <SettingsPageHead title={t('group.settings.title')} onClose={onClose} mobile /> : null}
        <div style={bodyStyle}>
          <div style={profileRowStyle}>
            {/* .gi 52px 群头像。@@@group-avatar (#1164 G1):manager 点击打开「修改头像」、拖入图片直接更换;非 manager 只读。 */}
            <div
              data-testid="group-avatar"
              title={viewerIsManager ? t('group.settings.changeAvatar') : undefined}
              onClick={viewerIsManager && !avatarUploading ? () => setAvatarEditing(true) : undefined}
              onDragOver={viewerIsManager ? (event) => { event.preventDefault(); setAvatarDragOver(true) } : undefined}
              onDragLeave={viewerIsManager ? () => setAvatarDragOver(false) : undefined}
              onDrop={viewerIsManager ? (event) => { event.preventDefault(); setAvatarDragOver(false); void handleAvatarFile(event.dataTransfer.files?.[0]) } : undefined}
              style={avatarDragOver ? avatarFrameDragStyle : viewerIsManager && !avatarUploading ? avatarFrameEditableStyle : avatarFrameStyle}
            >
              <Avatar variant="group" name={groupName ?? t('group.settings.groupFallback')} avatarUrl={settings?.avatar_url ?? null} seed={chatId} size={52} />
              {avatarUploading ? <div style={avatarUploadingStyle}>{t('group.settings.uploading')}</div> : null}
            </div>
            {avatarEditing ? (
              <GroupAvatarEditor chatId={chatId} groupName={groupName ?? ''} avatarUrl={settings?.avatar_url ?? null} busy={avatarUploading} onFile={handleAvatarFile} onReset={handleAvatarReset} onClose={() => setAvatarEditing(false)} />
            ) : null}
            <div style={profileTextStyle}>
              <GroupNameRow chat={chat} name={groupName} canEdit={viewerIsManager && Boolean(settings)} onCommit={handleRename} />
              <div style={memberCountStyle}>{t('group.settings.memberCount', { count: totalMembers })}</div>
            </div>
          </div>

          <GroupMembersRow chatId={chatId} settings={settings} memberIds={unifiedMembers.map((member) => member.id)} total={totalMembers} onOpen={() => openMembers(false)} onInvite={() => openMembers(true)} />
          <GroupFolderRow chatId={chatId} />
          <SettingsNavRow title={t('header.announcement')} testId="group-settings-announcement" onClick={() => push('announcement')} />
          <SettingsNavRow title={t('group.settings.rules')} testId="group-settings-rules" value={settings ? firstLine(settings.group_prompt) ?? t('group.settings.rulesUnset') : undefined} onClick={() => openTextPage('rules')} />
          <SettingsNavRow title={t('group.settings.description')} testId="group-settings-description" value={settings ? firstLine(settings.description) ?? t('group.settings.descriptionUnset') : undefined} onClick={() => openTextPage('description')} />
          {viewerIsManager && settings ? (
            <SettingsNavRow title={t('group.settings.manage')} testId="group-settings-manage" onClick={() => push('manage')} />
          ) : null}

          <div style={settingsSectionLabelStyle}>{t('group.settings.sectionChat')}</div>
          <ChatManagementActions
            activeChat={chat}
            appearance="settings"
            onClose={onClose}
            onClearMessages={onClearMessages}
            beforeClear={<div style={settingsSectionLabelStyle}>{t('group.settings.sectionDanger')}</div>}
            onSetNotificationLevel={onSetNotificationLevel}
            onTogglePinned={onTogglePinned}
          />

          {canExit ? (
            confirmExit ? (
              <div style={confirmStyle}>
                <p style={confirmTextStyle}>{viewerRole === 'owner' ? t('group.settings.dissolveConfirm') : t('group.settings.leaveConfirm')}</p>
                <div style={confirmActionsStyle}>
                  <Button variant="danger" size="sm" disabled={busy} style={confirmButtonStyle} onClick={() => { void handleExit() }}>
                    {viewerRole === 'owner' ? t('group.settings.dissolve') : t('group.settings.leave')}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} style={confirmButtonStyle} onClick={() => setConfirmExit(false)}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : (
              <div role="button" data-testid="group-settings-exit" style={leaveStyle} onClick={() => setConfirmExit(true)}>
                {viewerRole === 'owner' ? t('group.settings.dissolve') : t('group.settings.leave')}
              </div>
            )
          ) : null}
          {errorLine}
        </div>
      </>
    )
  }

  return <SettingsPageFrame page={page}>{content}</SettingsPageFrame>
}
