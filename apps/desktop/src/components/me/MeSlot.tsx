import { useCallback, useId } from 'react'
import { readShellSlots } from '@/lib/shellSlots'

export const ME_SLOT_PREFIX = 'me:'

/**
 * 界面减法 #51: my own avatar at the foot of the sidebar opens my menu (积分, 联系人, 市场, the Apps, 设置). The
 * account shell draws it (MeHost) into this slot, in its own contexts, with the update button beside it while an update
 * is available. `rail`: only the avatar fits, the update button above it; open, its name follows it.
 */
export function MeSlot({ rail }: { rail: boolean }) {
  const id = useId()
  const key = `${ME_SLOT_PREFIX}${id}`
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(key, element, rail ? 'rail' : 'open'), [key, rail])
  return <div ref={ref} data-me-slot={rail ? 'rail' : 'open'} className={rail ? 'flex flex-col-reverse items-center gap-2' : 'flex min-w-0 flex-1 items-center gap-1'} />
}
