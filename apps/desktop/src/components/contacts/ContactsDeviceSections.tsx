import { ListRow } from '../ui/ListRow'
import { SectionLabel } from '../ui/SectionLabel'
import type { ReactNode } from 'react'
import { Monitor, Server, User, UserPlus, Users, type IconComponent } from '@/lib/icons'
import { Chip } from '../ui/Chip'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { sectionCount, type ContactsSection } from './contactsSections'
import { sidebarCountClass } from '../../session/renderer/features/sidebar/sidebar-primitives'
import { ct, rowKeyActivate } from './contactsPanelStyles'
import { cn } from '@/lib/cn'

// 桌面通讯录左栏的分组行(分组本身见 contactsSections):一行一个、带计数,❌ 折叠展开;
// 点一下,右边大区域铺开这一组的全部联系人(ContactsSectionPane)。

const REQUESTS = 'new-requests'
const iconOf = (section: ContactsSection) =>
  section.kind === 'people' ? User : section.kind === 'groups' ? Users
    : section.scope === 'local' ? Monitor : Server

/** 左栏整列只有一种行:导航胶囊、裸图标、右端计数 —— 「新的请求」与各分组同形(选中 / 悬停 / 禁用都来自 .gg-row)。 */
export function ContactsSectionNav({ sections, selectedKey, onSelect, requests }: {
  sections: ContactsSection[]
  selectedKey: string | null
  onSelect: (key: string) => void
  requests: { count: number; active: boolean; disabled: boolean; onSelect: () => void }
}) {
  const row = (key: string, Icon: IconComponent, title: string, meta: ReactNode, selected: boolean, select: () => void, disabled = false, className?: string) => (
    <ListRow
      key={key}
      className={className}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      variant="nav"
      data-testid={key === REQUESTS ? AUTOMATION_TEST_IDS.contactsNewFriendsNav : 'contacts-section-nav'}
      data-section-key={key === REQUESTS ? undefined : key}
      selected={selected}
      leading={<span className="grid h-[var(--avatar-sm)] w-[var(--avatar-sm)] shrink-0 place-items-center text-[var(--muted-fg)]"><Icon size={18} /></span>}
      title={title}
      meta={meta}
      onClick={select}
      onKeyDown={rowKeyActivate(select)}
    />
  )
  // 设备一组带一行小标题;人 / 群紧随其后只隔一段留白(页标题已是「联系人」,❌ 再写一遍)。计数退到 --faint-fg,不和名字抢。
  const sectionRow = (section: ContactsSection, className?: string) => row(section.key, iconOf(section), section.title,
    <span className={cn(sidebarCountClass, 'text-[var(--faint-fg)]')}>{sectionCount(section)}</span>,
    !requests.active && section.key === selectedKey, () => onSelect(section.key), false, className)
  const devices = sections.filter((section) => section.kind === 'device')
  const rest = sections.filter((section) => section.kind !== 'device')
  return [
    row(REQUESTS, UserPlus, ct('panel.newRequests'), requests.count > 0 ? <Chip tone="accent" shape="count">{requests.count}</Chip> : null,
      requests.active, requests.onSelect, requests.disabled),
    <SectionLabel key="devices-label" className="!mt-4">{ct('panel.devicesHeading')}</SectionLabel>,
    ...devices.map((section) => sectionRow(section)),
    ...rest.map((section, index) => sectionRow(section, index === 0 ? '!mt-4' : undefined)),
  ]
}
