import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { Search } from '@/lib/icons'
import { recentChatActivity, searchContacts } from '@/lib/contactSearch'
import { normalizeMentionKey } from '@/lib/mentionMatch'
import { useShellTabIs } from '@/lib/shellTab'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { useChatsWhile } from '../../store/chatContext'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { SectionLabel } from '../ui/SectionLabel'
import { Illustration } from '../ui/Illustration'
import { PaneEmptyState } from '../ui/PaneEmptyState'
import { Button } from '../ui/Button'
import type { ContactsSection } from './contactsSections'
import { buildAgentForest, flattenForest, useAgentParents, type AgentTreeNode } from './contactsAgentTree'
import { SearchHitRow, SearchMap, type Hit } from './ContactsSearchHits'
import { ContactsPageFrame } from './ContactsPageFrame'
import { ContactsGrid } from './ContactsGrid'

// 通讯录桌面的搜索:框在左栏顶上,结果铺在右边大区域(ContactsPageFrame,与分组页同一副页头 + 抽屉)。
// 结果按分组分节(本机 / 各设备 / 咕咕云 / 个人 / 群组,与左栏同一份分组),命中的字满墨。设备分组里命中的 agent 画回
// 它的家族图(家族画全、没命中的淡下去),在家族里的位置一眼可见;人和群是行。键盘留在框里:↑↓ 按屏上的次序移动,
// 回车打开;点开 = 切到那一组、选中、开抽屉(由调用方 onOpen* 做)。
// ⌘F 在通讯录上就是这个框(同自动化页 / 会话历史:「当前视图内查找」= 聚焦自己的搜索框),❌ 第二套页内查找。

export function useDesktopContactSearch({ enabled, query, onQuery, sections, people, agents, groups, pick, onOpenContact, onOpenGroup, onSearchEveryone }: {
  /** 只有桌面:手机首页的框是 ContactSearch(HeaderSearch),❌ 在这里再挂一个 ⌘F。 */
  enabled: boolean
  query: string
  onQuery: (query: string) => void
  sections: ContactsSection[]
  people: ContactUser[]
  agents: ContactUser[]
  groups: ContactGroupChat[]
  /** 多选建群时:可勾的人点一下 = 勾选(框里的字留着,接着搜下一个)。 */
  pick?: { ids: ReadonlySet<string>; can: (contact: ContactUser) => boolean; onToggle: (contact: ContactUser) => void }
  onOpenContact: (contact: ContactUser, sectionKey: string) => void
  onOpenGroup: (group: ContactGroupChat, sectionKey: string) => void
  onSearchEveryone: (number: string) => void
}): { field: ReactNode; pane: ReactNode | null } {
  const { t } = useTranslation('contacts')
  const onScreen = useShellTabIs('contacts')
  const input = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(0)
  const searching = query.trim().length > 0
  const chats = useChatsWhile(enabled && searching)
  const recentAt = useMemo(() => recentChatActivity(chats), [chats])
  const result = useMemo(() => (enabled ? searchContacts(query, { people, agents, groups, recentAt }) : null), [enabled, query, people, agents, groups, recentAt])
  const parents = useAgentParents()
  // 命中按左栏的分组排。设备分组:先是家族里的 agent(家族按出现次序、各家族先序,再是单个 agent ——
  // 与 AgentFamilies 画的次序一致,键盘走的就是屏上的次序),再是群;其余分组保持搜索排好的次序。
  const bySection = useMemo(() => {
    if (!result) return []
    const sectionOf = new Map<string, ContactsSection>()
    for (const section of sections) for (const item of [...section.agents, ...section.people, ...section.groups]) sectionOf.set(item.id, section)
    const hits: Hit[] = [
      ...[...result.people, ...result.agents].flatMap((hit) => { const section = sectionOf.get(hit.item.id); return section ? [{ kind: 'contact' as const, hit, section }] : [] }),
      ...result.groups.flatMap((hit) => { const section = sectionOf.get(hit.item.id); return section ? [{ kind: 'group' as const, hit, section }] : [] }),
    ]
    return sections.flatMap((section) => {
      const mine = hits.filter((hit) => hit.section === section)
      if (mine.length === 0) return []
      if (section.kind !== 'device') return [{ section, hits: mine, forest: [] }]
      const agentHits = new Map(mine.flatMap((row) => (row.kind === 'contact' ? [[row.hit.item.id, row] as const] : [])))
      const has = (node: AgentTreeNode): boolean => agentHits.has(node.contact.id) || node.children.some(has)
      const forest = buildAgentForest(section.agents, parents).filter(has)
      const drawn = [...forest.filter((node) => node.children.length > 0), ...forest.filter((node) => node.children.length === 0)]
      const ordered = flattenForest(drawn).flatMap((node) => agentHits.get(node.contact.id) ?? [])
      return [{ section, hits: [...ordered, ...mine.filter((row) => row.kind === 'group')], forest }]
    })
  }, [result, sections, parents])
  const rows = bySection.flatMap((group) => group.hits)
  const digits = normalizeMentionKey(query)
  const lookup = result && rows.length === 0 && /^\d+$/.test(digits) ? digits : null
  const current = Math.min(active, rows.length - 1)

  const open = (row: Hit) => {
    if (row.kind === 'contact' && pick?.can(row.hit.item)) return pick.onToggle(row.hit.item)
    onQuery('')
    setActive(0)
    if (row.kind === 'group') onOpenGroup(row.hit.item, row.section.key)
    else onOpenContact(row.hit.item, row.section.key)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && searching) { event.preventDefault(); onQuery(''); return }
    if (lookup && event.key === 'Enter') { event.preventDefault(); onSearchEveryone(lookup); return }
    if (rows.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      open(rows[current]!)
    }
  }
  // ⌘F(「当前视图内查找」app.find 绑的那个键)在通讯录上就是聚焦这个框。通讯录画在外壳里,会话页隐藏时它照样要答。
  useCommandProvider({
    scopeId: 'session-sub',
    surface: 'shell',
    isActive: () => enabled && onScreen,
    getCommands: () => [{ id: 'app.find', hideFromPalette: true, execute: () => { input.current?.focus(); input.current?.select() } }],
  })

  const field = (
    <div className="shrink-0 !px-3 !pb-2">
      <SearchField
        variant="nav"
        ref={input}
        data-testid={AUTOMATION_TEST_IDS.contactsSearchInput}
        value={query}
        onChange={(event) => { onQuery(event.target.value); setActive(0) }}
        onKeyDown={onKeyDown}
        placeholder={t('panel.searchContacts')}
        clearLabel={t('friendSearch.clearSearch')}
        onClear={() => onQuery('')}
      />
    </div>
  )
  if (!enabled || !searching) return { field, pane: null }

  const pane = (
    <ContactsPageFrame testId="contacts-search-results" title={t('searchPane.title', { query: query.trim() })} subtitle={t('searchPane.count', { count: rows.length })}>
      {bySection.map(({ section, hits, forest }) => (
        <section key={section.key}>
          <SectionLabel className="!mt-4">{section.title} · {hits.length}</SectionLabel>
          {forest.length > 0 ? (
            <SearchMap forest={forest} hits={hits} current={rows[current]} pick={pick} onOpen={open} onOpenContact={(c) => { onQuery(''); onOpenContact(c, section.key) }} />
          ) : null}
          <ContactsGrid>
            {hits.filter((row) => section.kind !== 'device' || row.kind === 'group').map((row) => (
              <SearchHitRow key={row.hit.item.id} row={row} picked={row.kind === 'contact' && pick?.can(row.hit.item) ? pick.ids.has(row.hit.item.id) : undefined} active={row === rows[current]} onOpen={() => open(row)} />
            ))}
          </ContactsGrid>
        </section>
      ))}
      {rows.length === 0 ? (
        lookup ? (
          <ContactsGrid className="!mt-4">
            <ListRow role="button" tabIndex={0} selected onClick={() => onSearchEveryone(lookup)}
              leading={<div className="grid size-[var(--avatar-sm)] shrink-0 place-items-center text-[var(--muted-fg)]"><Search size={16} /></div>}
              title={t('panel.lookupGuguNumber', { number: lookup })} />
          </ContactsGrid>
        ) : (
          <div className="grid min-h-[60%] place-items-center">
            <PaneEmptyState art={<Illustration name="no-match" className="w-[96px]" />} caption={t('searchPane.empty', { query: query.trim() })}
              hint={t('searchPane.emptyHint')}
              action={<Button variant="secondary" size="sm" data-testid="contacts-search-everyone" onClick={() => onSearchEveryone(query.trim())}><Search size={15} aria-hidden />{t('searchPane.searchEveryone')}</Button>} />
          </div>
        )
      ) : null}
    </ContactsPageFrame>
  )
  return { field, pane }
}
