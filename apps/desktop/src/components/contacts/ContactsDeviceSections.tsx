import { ListRow } from '../ui/ListRow'
import { Monitor, Server, User, Users } from '@/lib/icons'
import { sectionCount, type ContactsSection } from './contactsSections'
import { sidebarCountClass } from '../../session/renderer/features/sidebar/sidebar-primitives'
import { rowKeyActivate } from './contactsPanelStyles'

// 桌面通讯录左栏的分组行(分组本身见 contactsSections):一行一个、带计数,❌ 折叠展开;
// 点一下,右边大区域铺开这一组的全部联系人(ContactsSectionPane)。

const iconOf = (section: ContactsSection) =>
  section.kind === 'people' ? User : section.kind === 'groups' ? Users
    : section.scope === 'local' ? Monitor : Server

export function ContactsSectionNav({ sections, selectedKey, onSelect }: {
  sections: ContactsSection[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  return (
    <>
      {sections.map((section) => {
        const Icon = iconOf(section)
        const select = () => onSelect(section.key)
        return (
          <ListRow
            key={section.key}
            role="button"
            tabIndex={0}
            variant="nav"
            data-testid="contacts-section-nav"
            data-section-key={section.key}
            selected={section.key === selectedKey}
            leading={<span className="grid h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 place-items-center text-[var(--muted-fg)]"><Icon size={18} /></span>}
            title={section.title}
            meta={<span className={sidebarCountClass}>{sectionCount(section)}</span>}
            onClick={select}
            onKeyDown={rowKeyActivate(select)}
          />
        )
      })}
    </>
  )
}
