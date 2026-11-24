import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
const { MemberProfileCard } = await import('@/components/MemberProfileCard')
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const person = { id: 'person', guguNumber: 115377, displayName: 'A person', avatar: null, email: null, type: 'human', role: 'member', profileScope: 'group', membership: 'current' } as MemberProfileCardModel
const agent = { id: 'agent', guguNumber: 120001, displayName: 'One word reply test agent', avatar: null, email: null, type: 'agent', role: 'member', profileScope: 'group', membership: 'current', ownerUserId: 'someone-else', ownerDisplayName: 'Owner' } as MemberProfileCardModel

async function card(member: MemberProfileCardModel) {
  harness?.cleanup()
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  await renderWithAppProviders(harness, <MemberProfileCard member={member} onWhisper={() => {}} onFindMessages={() => {}} />)
  const root = harness.container.querySelector<HTMLElement>('.gg-pop')!
  const actions = [...root.querySelectorAll<HTMLElement>('.gg-pop-pacts button')]
  return {
    width: root.getBoundingClientRect().width,
    actions: actions.map((b) => ({ text: b.textContent, height: Math.round(b.getBoundingClientRect().height), width: Math.round(b.getBoundingClientRect().width), svg: b.querySelector('svg')?.getAttribute('data-icon') ?? b.querySelector('svg')?.innerHTML.length })),
    fields: [...root.querySelectorAll<HTMLElement>('[data-profile-field]')].map((f) => f.dataset.profileField),
  }
}

it('a person and an agent in a group get the same card: width, action layout, icons and rows', async () => {
  await page.viewport(1100, 800)
  const p = await card(person)
  const a = await card(agent)
  expect(a.width).toBe(p.width)
  // Whisper and Find messages are the same buttons, same size and same glyphs, for both kinds.
  expect(a.actions.slice(0, 2)).toEqual(p.actions.slice(0, 2))
  // Group role and Gugu ID show for the agent too.
  expect(a.fields).toEqual(expect.arrayContaining(['role', 'id']))
  expect(p.fields).toEqual(expect.arrayContaining(['role', 'id']))
})

it("someone else's agent has no Share; a person's Share is the same third button", async () => {
  await page.viewport(1100, 800)
  const p = await card(person)
  const a = await card(agent)
  expect(p.actions.map((b) => b.text)).toEqual(['Whisper', 'Search', 'Share'])
  expect(a.actions.map((b) => b.text)).toEqual(['Whisper', 'Search'])
})

it('a long agent name wraps to two lines instead of being cut', async () => {
  await page.viewport(1100, 800)
  await card(agent)
  const name = harness.container.querySelector<HTMLElement>('.gg-pop-pn')!
  expect(name.scrollWidth, 'no horizontal cut').toBeLessThanOrEqual(name.clientWidth)
  expect(name.scrollHeight, 'no line clipped').toBeLessThanOrEqual(name.clientHeight)
})
