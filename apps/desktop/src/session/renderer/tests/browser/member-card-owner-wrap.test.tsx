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

it("shows an agent card's whole owner line, wrapping instead of cutting it", async () => {
  await page.viewport(1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  const agent = { id: 'agent', displayName: '自我介绍', avatar: null, type: 'agent', role: 'member', profileScope: 'group', membership: 'current', ownerUserId: 'owner', ownerDisplayName: 'Test User Other from the design team' } as MemberProfileCardModel
  await renderWithAppProviders(harness, <MemberProfileCard member={agent} />)
  const owner = harness.container.querySelector<HTMLElement>('[data-profile-agent-owner]')!
  expect(owner.textContent).toContain('Test User Other from the design team')
  expect(owner.getClientRects().length + ':' + Math.round(owner.getBoundingClientRect().height), 'two lines').toBe('1:32')
  expect(owner.scrollWidth, 'no horizontal cut').toBeLessThanOrEqual(owner.clientWidth)
  expect(owner.scrollHeight, 'no line clipped').toBeLessThanOrEqual(owner.clientHeight)
})
