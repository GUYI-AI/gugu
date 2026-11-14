import { useMemo, useState } from 'react'
import type { ActiveMemberProfile, MemberProfileOpener } from '@/components/memberProfileModels'
import { Popover } from '@/components/ui/Popover'

/**
 * The profile card a message avatar opens. The main thread and its topic split share this one card; every avatar is its
 * Trigger (a second press on the same avatar closes it), and `openedFrom` says which column it was opened in.
 */
export function useMessageProfileCard() {
  const [card] = useState(() => Popover.createHandle<ActiveMemberProfile>())
  const mainOpener = useMemo((): MemberProfileOpener => ({ handle: card, openedFrom: 'main' }), [card])
  const asideOpener = useMemo((): MemberProfileOpener => ({ handle: card, openedFrom: 'aside' }), [card])
  return { card, mainOpener, asideOpener }
}
