import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AgentContactRow } from '@/components/contacts/AgentContactRow'
import { contact, createReactHarness } from '../../../../../../../tests/support/testHarness'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/partners/partners.css'

vi.mock('@/hooks/useAgentDisplayStatus', () => ({
  useAgentDisplayStatus: (status: string) => ({ status, presence: {} }),
}))

const actions = {
  onSelect() {},
  onToggleSelection() {},
  onPin() {},
  onMarkUnread() {},
  onToggleNotif() {},
  onRemove() {},
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

it('paints the Partners status corner outside the 40px portrait', async () => {
  await page.viewport(390, 844)
  await harness.render(
    <div data-phone-shell="" className="gg-partners">
      <div className="gg-partners-list">
        {['idle', 'working', 'offline'].map((status) => (
          <AgentContactRow key={status} mobile selected={false} actions={actions}
            contact={contact({ id: status, type: 'agent', display_name: status, avatar: null })} />
        ))}
      </div>
    </div>,
  )

  const row = (status: string) => harness.container.querySelector(`[data-contact-id="${status}"]`)!
  expect(row('idle').querySelector('.av-status')).toBeNull()
  for (const status of ['working', 'offline']) {
    const portrait = row(status).querySelector('[data-agent-avatar-boring]')!.getBoundingClientRect()
    const mark = row(status).querySelector<HTMLElement>(`.av-status--${status}`)!
    const badge = mark.getBoundingClientRect()
    expect(portrait.width).toBe(40)
    expect(portrait.height).toBe(40)
    expect(badge.right).toBe(portrait.right + 2)
    expect(badge.bottom).toBe(portrait.bottom + 2)

    // Clipping does not change boundingClientRect. Temporarily opt into hit testing to check the painted region.
    mark.style.pointerEvents = 'auto'
    expect(document.elementsFromPoint(badge.x + badge.width / 2, portrait.bottom + 1)).toContain(mark)
  }
})
