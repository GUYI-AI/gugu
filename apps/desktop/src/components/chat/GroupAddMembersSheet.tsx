import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { groupRoster } from '../../hooks/useRoomCollab'
import { useReplica } from '../../lib/replica'
import { groupInviteAccess, isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { groupJoinError } from '../../lib/groupAgentJoinService'
import { UI_EVENTS } from '../../lib/uiEvents'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Button'
import { AddGroupMembers } from './AddGroupMembers'
import { groupSettings } from './useGroupChatSettings'

/** The group's 「添加成员」 picker, loading the group itself: the add menu (GroupAddMenu) and a task dropped on a group's composer. */
export function GroupAddMembersSheet({ chatId, initialSelectedIds, onClose }: {
  chatId: string; initialSelectedIds?: readonly string[]; onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  // The group's roster and settings readings: the sheet opens on what the chat already read.
  const roster = useReplica(groupRoster, [chatId, 'group'])
  const settingsReading = useReplica(groupSettings, [chatId])
  const projectGroup = isProjectGroupChat(chatId)
  const failure = roster.state === 'error' ? roster.error : settingsReading.state === 'error' ? settingsReading.error : null
  const notMember = settingsReading.state === 'value' && !settingsReading.value.my_role
  const error = failure ? groupJoinError(failure).message : notMember ? groupJoinError(new Error('actor_not_member')).message : null
  const group = !error && roster.state === 'value' && settingsReading.state === 'value'
    ? { snapshot: roster.value, settings: settingsReading.value, canInviteHumans: groupInviteAccess(chatId, 'group', settingsReading.value).canInviteHumans }
    : null
  if (!group) return <Sheet onClose={onClose} ariaLabel={t('group.picker.title')}>
    <div className="!p-5">
      <p role={error ? 'alert' : 'status'}>{error ?? t('common.loading')}</p>
      <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
    </div>
  </Sheet>
  return <AddGroupMembers chatId={chatId} snapshot={group.snapshot} settings={group.settings} canInviteHumans={group.canInviteHumans}
    humanDeniedHint={projectGroup ? t('group.projectGroupNoInvite') : undefined} initialSelectedIds={initialSelectedIds} onClose={onClose}
    onReload={async () => {
      await groupRoster.refresh(chatId)
      window.dispatchEvent(new CustomEvent(UI_EVENTS.groupCollabChanged, { detail: { chatId } }))
    }} />
}

/**
 * 「添加成员」 from any group's 「+」 (GroupAddMenu), drawn here in the shell, under its contacts and devices. The picker's
 * candidates are those two providers; the inner column's 「+」 lives in the task page's own React root, which has neither,
 * so a picker mounted beside that 「+」 had nobody to pick. Mounted once (MainLayout); it sits over whatever page asked.
 */
export function GroupAddMembersHost() {
  const [chatId, setChatId] = useState<string | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      const asked = (event as CustomEvent<{ chatId?: unknown }>).detail?.chatId
      if (typeof asked === 'string' && asked.length > 0) setChatId(asked)
    }
    window.addEventListener(UI_EVENTS.addGroupMembers, open)
    return () => window.removeEventListener(UI_EVENTS.addGroupMembers, open)
  }, [])
  return chatId ? <GroupAddMembersSheet key={chatId} chatId={chatId} onClose={() => setChatId(null)} /> : null
}
