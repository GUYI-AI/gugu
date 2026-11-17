import { Archive, BellOff, CheckCircle, Copy, GitFork, History, PanelLeft, PanelLeftClose, Pencil, Pin, PinOff, RotateCcw, Trash } from '@/lib/icons'
import { i18n } from '@/i18n'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { SessionMenuItem, SessionMenuLabel } from '../session/shared/session-menu'

const ICONS = {
  read: CheckCircle, pin: Pin, unpin: PinOff, sidebar: PanelLeft, 'sidebar-off': PanelLeftClose, rename: Pencil, bell: BellOff,
  archive: Archive, fork: GitFork, copy: Copy, reload: RotateCcw, history: History, trash: Trash,
} satisfies Record<SessionMenuItem['icon'], unknown>

/** A session menu icon (the tab menu takes the component). */
export const sessionMenuIcon = (icon: SessionMenuItem['icon']) => ICONS[icon]

/** A session menu label in its own catalog. */
export function sessionMenuLabel(label: SessionMenuLabel): string {
  return label.ns === 'session' ? translateSessionMessage(label.key) : i18n.t(label.key, { ns: 'messaging' })
}
