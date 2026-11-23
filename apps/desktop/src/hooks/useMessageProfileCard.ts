import { useMemo, useState } from 'react'
import type { ActiveMemberProfile, MemberProfileOpener } from '@/components/memberProfileModels'
import { Popover } from '@/components/ui/Popover'

/**
 * The profile card a message avatar opens; every avatar is its Trigger (a second press on the same avatar closes it).
 */
export function useMessageProfileCard() {
  const [card] = useState(() => Popover.createHandle<ActiveMemberProfile>())
  const mainOpener = useMemo((): MemberProfileOpener => ({ handle: card, openedFrom: 'main' }), [card])
  return { card, mainOpener }
}
