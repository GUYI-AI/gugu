// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSharePane } from '../../../../apps/desktop/src/components/agentsettings/AgentSharePane'
import { clickElement, contact, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => { h.cleanup(); vi.restoreAllMocks() })
const button = (label: string) => [...h.container.querySelectorAll('button')].find(b => b.textContent === label)!

it('publishing goes through the contacts store, which mints the 咕咕号; no half-made link before it arrives', async () => {
  const agent = contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })
  const setAgentPublic = vi.fn(async () => {})
  await renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' }, contacts: { contacts: [agent], setAgentPublic } })
  await clickElement(button('对外分享'))
  expect(h.container.textContent).not.toMatch(/费用|手续费|赠送|即将/)
  expect(h.container.querySelector('[data-testid="agent-share-link"]')).toBeNull()
  expect(h.container.querySelector('.gg-as-share-act-ext')!.querySelectorAll('button')).toHaveLength(1)
  await clickElement(button('开启对外分享'))
  expect(setAgentPublic).toHaveBeenCalledWith('a1', true)
  expect(h.container.querySelector('[data-testid="agent-share-link"]')).toBeNull()
})

it('a public agent shares its contact short link, the same code as its poster', async () => {
  const agent = contact({ id: 'a1', type: 'agent', owner_user_id: 'u1', agent_public: true, gugu_number: 5551234 })
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  await renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' }, contacts: { contacts: [agent] } })
  await clickElement(button('对外分享'))
  expect(h.container.querySelector('[data-testid="agent-share-link"]')?.textContent).toBe('https://gugu.nextmind.space/j/?5551234')
  await clickElement(h.container.querySelector('[data-testid="agent-share-link"] + button')!)
  expect(copy).toHaveBeenCalledWith('https://gugu.nextmind.space/j/?5551234')
})
