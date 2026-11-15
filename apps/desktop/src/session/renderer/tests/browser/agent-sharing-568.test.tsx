import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AgentSharePane } from '@/components/agentsettings/AgentSharePane'
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => { h.cleanup(); vi.restoreAllMocks() })
for (const mobile of [false, true]) it(`shares the agent's contact short link once publishing minted its number (mobile=${mobile})`, async () => {
  await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
  await i18n.changeLanguage('zh-CN')
  const agent = contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })
  const setAgentPublic = vi.fn(async () => {})
  h.container.style.cssText = 'padding:24px;max-width:720px;margin:auto'
  await renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' }, contacts: { contacts: [agent], setAgentPublic } })
  // Align the search control with the empty state; its input reserves space for the search icon.
  expect(h.container.querySelector('[data-slot="search-field"]')!.getBoundingClientRect().left).toBe(h.container.querySelector('.gg-as-share-act-empty')!.getBoundingClientRect().left)
  await page.getByRole('button', { name: '对外分享', exact: true }).click()
  expect(h.container.querySelector('[data-testid="agent-share-link"]')).toBeNull()
  expect(h.container.querySelector('.gg-as-share-act-ext')!.querySelectorAll('button')).toHaveLength(1)
  await page.getByRole('button', { name: '开启对外分享', exact: true }).click()
  expect(setAgentPublic).toHaveBeenCalledWith('a1', true)
  // The store puts the minted identity back into contacts; the panel reads the number from there.
  const minted = { ...agent, agent_public: true, gugu_number: 5551234 }
  await renderWithAppProviders(h, <AgentSharePane agent={minted} />, { auth: { id: 'u1' }, contacts: { contacts: [minted], setAgentPublic } })
  await page.getByRole('button', { name: '对外分享', exact: true }).click()
  await until('published link is shown', () => !!h.container.querySelector('[data-testid="agent-share-link"]'))
  expect(h.container.querySelector('[data-testid="agent-share-link"]')!.textContent).toBe('https://gugu.nextmind.space/j/?5551234')
  const copy = h.container.querySelector('[data-testid="agent-share-link"] + button')!
  expect(getComputedStyle(copy).backgroundColor).toBe('rgba(0, 0, 0, 0)')
})
