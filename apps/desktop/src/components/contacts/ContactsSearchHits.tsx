import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ContactSearchHit } from '@/lib/contactSearch'
import { displayName } from '@/lib/contactsListSort'
import { Avatar } from '../Avatar'
import { ListRow } from '../ui/ListRow'
import type { ContactsSection } from './contactsSections'
import { ContactGroupAvatar, Marked, SelectionCheckbox } from './ContactSearch'
import type { AgentTreeNode } from './contactsAgentTree'
import { AgentMindMap } from './AgentMindMap'

// 桌面通讯录搜索结果里的两种命中:设备分组里的 agent 画回家族图(SearchMap),人与群是行(SearchHitRow)。

export type Hit =
  | { kind: 'contact'; hit: ContactSearchHit<ContactUser>; section: ContactsSection }
  | { kind: 'group'; hit: ContactSearchHit<ContactGroupChat>; section: ContactsSection }

/** 设备分组里命中的 agent 画回它们的家族图:含命中的家族画全(没命中的淡下去,点它照样打开),命中的单个 agent 进头像格。 */
export function SearchMap({ forest, hits, current, pick, onOpen, onOpenContact }: {
  forest: AgentTreeNode[]
  pick?: { ids: ReadonlySet<string>; can: (contact: ContactUser) => boolean }
  hits: Hit[]
  current: Hit | undefined
  onOpen: (row: Hit) => void
  onOpenContact: (contact: ContactUser) => void
}) {
  const byId = new Map(hits.flatMap((row) => (row.kind === 'contact' ? [[row.hit.item.id, row] as const] : [])))
  // 命中的节点写搜到的那个名字(命中位置是按它算的),❌ 导图平时显示的名字(新建的 agent 那里是「正在起名…」)。
  const label = (contact: ContactUser, name: string) => {
    const row = byId.get(contact.id)
    return row && row.hit.field === 'title' ? <Marked text={row.hit.text} hits={row.hit.hits} /> : name
  }
  return (
    <AgentMindMap
      forest={forest}
      dimmed={(contact) => !byId.has(contact.id)}
      label={label}
      selectedId={current?.kind === 'contact' ? current.hit.item.id : null}
      onSelect={(contact) => { const row = byId.get(contact.id); if (row) onOpen(row); else onOpenContact(contact) }}
      menuFor={() => undefined}
      pick={pick}
    />
  )
}

/** 人与群的命中行(agent 都在设备分组的导图里)。命中的不是名字时(原名 / 咕咕号 / 群号),副行写出命中的那个字段。 */
export function SearchHitRow({ row, picked, active, onOpen }: { row: Hit; picked?: boolean; active: boolean; onOpen: () => void }) {
  const { t } = useTranslation('contacts')
  const { hit } = row
  const title = row.kind === 'group' ? groupDisplayName(row.hit.item) : displayName(row.hit.item)
  const why = hit.field === 'title' ? undefined : (
    <span>{hit.field === 'original' ? t('profile.originalName') : row.kind === 'group' ? t('groupDetail.number') : t('common.guguNumber')} <Marked text={hit.text} hits={hit.hits} /></span>
  )
  const avatar = row.kind === 'group' ? <ContactGroupAvatar group={row.hit.item} size="sm" /> : <Avatar name={title} avatarUrl={row.hit.item.avatar} seed={row.hit.item.id} size="sm" />
  const leading = picked === undefined ? avatar : <><SelectionCheckbox checked={picked} />{avatar}</>
  return (
    <ListRow
      role="button"
      tabIndex={0}
      data-search-hit={hit.item.id}
      data-contact-option={picked === undefined ? undefined : hit.item.id}
      aria-pressed={picked}
      selected={active}
      leading={leading}
      title={<Marked text={title} hits={hit.field === 'title' ? hit.hits : []} />}
      subtitle={why}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onOpen() } }}
    />
  )
}
