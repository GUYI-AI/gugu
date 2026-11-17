import { MoreHorizontal } from '@/lib/icons'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { SessionMenuAction, SessionMenuItem } from '../session/shared/session-menu'
import { sessionMenuIcon, sessionMenuLabel } from './sessionMenuPresentation'
import type { ReactNode } from 'react'
import { MenuFold, MenuItem } from './ui/Menu'

/** The rows of a session menu (session/shared/session-menu.ts), inside whichever menu the entry opens: unfolded first, then 更多. */
export function SessionMenuItems({ items, onAction, testIdPrefix = 'session-menu', foldExtra }: {
  items: readonly SessionMenuItem[]
  onAction: (id: SessionMenuAction) => void
  testIdPrefix?: string
  /** Rows about another object than the session (a screen group) that the entry keeps under 更多. */
  foldExtra?: ReactNode
}) {
  const row = (item: SessionMenuItem) => {
    const Icon = sessionMenuIcon(item.icon)
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={`${testIdPrefix}-${item.id}`} onClick={() => onAction(item.id)}>
      {sessionMenuLabel(item.label)}
    </MenuItem>
  }
  const folded = items.filter((item) => item.fold)
  return <>
    {items.filter((item) => !item.fold).map(row)}
    {(folded.length > 0 || foldExtra) && <MenuFold icon={<MoreHorizontal size={15} />} label={translateSessionMessage('common.more')} data-testid={`${testIdPrefix}-more`}>{foldExtra}{folded.map(row)}</MenuFold>}
  </>
}
