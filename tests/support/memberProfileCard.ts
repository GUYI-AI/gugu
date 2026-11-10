import { createElement, Fragment, type ReactElement } from 'react'
import { act } from 'react'
import { MemberProfilePopover, MemberProfileRoot } from '../../apps/desktop/src/components/MemberProfilePopover'
import type { ActiveMemberProfile } from '../../apps/desktop/src/components/memberProfileModels'
import { Popover } from '../../apps/desktop/src/components/ui/Popover'

type CardProps = Omit<Parameters<typeof MemberProfilePopover>[0], 'profile'>

/** A profile card the way the product opens one: an opener that is its Trigger, and the card in its Root (closing it closes the handle, as the hosts do). */
export function profileCardWithOpener(profile: ActiveMemberProfile, card: CardProps, opener: ReactElement = createElement('button', { 'data-testid': 'profile-opener' })) {
  const handle = Popover.createHandle<ActiveMemberProfile>()
  return createElement(Fragment, null,
    createElement(Popover.Trigger, { handle, payload: profile, render: opener }),
    createElement(MemberProfileRoot, { handle, children: (opened: ActiveMemberProfile) => createElement(MemberProfilePopover, { ...card, profile: opened, onClose: () => { card.onClose(); handle.close() } }) }))
}

export async function pressProfileOpener() {
  const opener = document.querySelector<HTMLElement>('[data-testid="profile-opener"]')
  if (!opener) throw new Error('profile opener not rendered')
  await act(async () => { opener.click(); await Promise.resolve() })
}
