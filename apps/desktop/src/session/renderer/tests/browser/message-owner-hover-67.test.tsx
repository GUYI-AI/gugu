import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { MessageSenderProvider } from '@/components/chat/MessageSenderProvider'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const { MessageBubble } = await import('@/components/chat/MessageBubble')
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it('shows an agent owner label only while its message is hovered, without moving the bubble', async () => {
  await page.viewport(1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;left:0;top:100px;width:900px'
  const agent = { id: 'peer', displayName: 'Claude 1', avatar: null, type: 'agent', ownerUserId: 'owner', ownerDisplayName: 'Alice' } as MemberProfileCardModel
  const msg = message({ id: 'agent', chat_id: 'group', sender_user_id: 'peer', content: 'ok', is_mine: false })
  await renderWithAppProviders(harness, <MessageSenderProvider message={msg} group>
    <MessageBubble msg={msg} isGroup memberProfile={agent} memberProfiles={{ peer: agent }}
      onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} onShowMessage={() => {}} />
  </MessageSenderProvider>)
  const tag = harness.container.querySelector<HTMLElement>('[data-message-agent-owner]')!
  const column = harness.container.querySelector<HTMLElement>('[data-message-bubble-column]')!
  const width = column.getBoundingClientRect().width
  expect(getComputedStyle(tag).visibility, 'at rest the owner label is not shown').toBe('hidden')
  await userEvent.hover(harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!)
  await expect.poll(() => getComputedStyle(tag).visibility).toBe('visible')
  expect(column.getBoundingClientRect().width, 'revealing the label does not resize the bubble').toBe(width)
})
