import { MoreHorizontal } from '@/lib/icons'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { menuLayout, type MenuTableItem } from '../session/shared/menu-table'
import { menuTableIcon, menuTableLabel } from './menuTablePresentation'
import type { ReactNode } from 'react'
import { MenuFold, MenuItem } from './ui/Menu'

/** The rows of an object's action table (session/shared/menu-table.ts), inside whichever menu the entry opens, laid out by `menuLayout`. */
export function MenuTableItems<A extends string>({ items, onAction, testIdPrefix = 'session-menu', foldExtra }: {
  items: readonly MenuTableItem<A>[]
  onAction: (id: A) => void
  testIdPrefix?: string
  /** Rows about another object (a screen group) that the entry keeps under 更多. */
  foldExtra?: ReactNode
}) {
  const row = (item: MenuTableItem<A>) => {
    const Icon = menuTableIcon(item.icon)
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={`${testIdPrefix}-${item.id}`} onClick={() => onAction(item.id)}>
      {menuTableLabel(item.label)}
    </MenuItem>
  }
  const { top, more: folded } = menuLayout(items)
  return <>
    {top.map(row)}
    {(folded.length > 0 || foldExtra) && <MenuFold icon={<MoreHorizontal size={15} />} label={translateSessionMessage('common.more')} data-testid={`${testIdPrefix}-more`}>{foldExtra}{folded.map(row)}</MenuFold>}
  </>
}
