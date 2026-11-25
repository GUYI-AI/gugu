import { useCallback, useId } from 'react'
import { readShellSlots } from '@/lib/shellSlots'

export const NOTIFICATION_TOGGLE_SLOT_PREFIX = 'notification-toggle:'
export const NOTIFICATION_LIST_SLOT_PREFIX = 'notification-list:'

/** The account shell renders the bell into toggle slots and the global notifications beside it: in a popover on the desktop,
 * into the phone's list slot. `tone` is the bell's: the desktop sidebar's foot draws it like the 会话历史 button beside it
 * (#2548); the phone's stays beside its 「+」. */
export function NotificationSlot({ part, active = true, tone }: { part: 'toggle' | 'list'; active?: boolean; tone?: 'strong' }) {
  const id = useId()
  const key = `${part === 'toggle' ? NOTIFICATION_TOGGLE_SLOT_PREFIX : NOTIFICATION_LIST_SLOT_PREFIX}${id}`
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(key, element, active ? 'active' : 'inactive'), [key, active])
  return <div ref={ref} data-notification-slot={part} data-tone={tone} hidden={!active} className={!active ? 'hidden' : part === 'list' ? 'flex min-h-0 flex-1 flex-col' : 'flex items-center'} />
}
