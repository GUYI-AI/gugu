import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../store/chatContext'
import { useContactsStore } from '../store/contactsContext'
import { useToast } from './toastContext'
import { messageForUser } from '../lib/userFacingError'
import { MemberPicker } from './member-picker/MemberPicker'
import { Field } from './ui/Field'
import { PaneEmptyState } from './ui/PaneEmptyState'

interface CreateGroupChatModalProps {
  onClose: () => void
  onCreated: (chatId: string) => void
  /** 模板名（如从工作台模板组建时传模板名）；群名框留空时用它，不再按所选成员起名。 */
  initialName?: string
  initialSelectedIds?: string[]
}

// 新建群聊 = 选成员(member-picker,与「添加成员」同一个选择器)+ 可选的群名 + 建群,群名随建群那一次调用写进去。
// 群名留空:有模板名用模板名,没有就是所选成员的名字按选中先后连起来。
export function CreateGroupChatForm({ onClose, onCreated, initialName, initialSelectedIds }: CreateGroupChatModalProps) {
  const { t } = useTranslation('contacts')
  const { contacts } = useContactsStore()
  const { createGroupChat } = useChatStore('createGroupChat')
  const { toast } = useToast()
  const [creating, setCreating] = useState(false)
  const [typedName, setTypedName] = useState('')

  const create = async (ids: string[]) => {
    const names = ids.flatMap((id) => contacts.find((contact) => contact.id === id)?.display_name ?? [])
    const name = typedName.trim() || (initialName ?? names.join('、')).trim() || t('createGroup.fallbackName')
    setCreating(true)
    try {
      onCreated(await createGroupChat(name, ids))
    } catch (e) {
      toast(t('createGroup.failed'), 'error', messageForUser(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <MemberPicker
      title={t('createGroup.title')}
      confirmLabel={(count) => (count > 0 ? t('createGroup.createWithCount', { count }) : t('createGroup.create'))}
      busy={creating}
      busyLabel={t('createGroup.creating')}
      initialSelectedIds={initialSelectedIds}
      underlineMobileSources
      actions={<Field.Input value={typedName} onChange={(event) => setTypedName(event.target.value)} disabled={creating}
        aria-label={t('createGroup.nameLabel')} placeholder={t('createGroup.namePlaceholder')} className="w-64 max-w-full" data-testid="create-group-name" />}
      // 一个联系人都没有时不画空的选人器(列表里一句「No contacts」+ 灰掉的确认键),直接说清先要做什么。
      empty={<PaneEmptyState caption={t('createGroup.noContactsTitle')} hint={t('createGroup.noContactsHint')} />}
      onConfirm={create}
      onClose={onClose}
    />
  )
}

export { MEMBER_PICKER_SHEET } from './member-picker/MemberPicker'
