import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { MessageSenderProvider } from '@/components/chat/MessageSenderProvider'
import { setLocalePreference } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
const { MessageBubble } = await import('@/components/chat/MessageBubble')
const { MessageQuote } = await import('@/components/chat/MessageQuote')
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); setLocalePreference('system') })

const agent = (removedAt: string | null) => ({ id: 'peer', displayName: 'Codex 1', avatar: null, type: 'agent', ownerUserId: 'owner', ownerDisplayName: 'Alice', removedAt, agentStatus: removedAt ? 'removed' : undefined }) as MemberProfileCardModel
const said = message({ id: 'said', chat_id: 'group', sender_user_id: 'peer', content: 'done', is_mine: false })
const reply = message({ id: 'reply', chat_id: 'group', sender_user_id: 'me', content: 'thanks', is_mine: true, reply_to_message_id: 'said', reply_to_sender_user_id: 'peer', reply_to_content: 'done' })

async function render(member: MemberProfileCardModel) {
  await page.viewport(1100, 800)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;left:0;top:100px;width:900px'
  await renderWithAppProviders(harness, <>
    <MessageSenderProvider message={said} group>
      <MessageBubble msg={said} isGroup memberProfile={member} memberProfiles={{ peer: member }}
        onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} onShowMessage={() => {}} />
    </MessageSenderProvider>
    <div data-testid="quote"><MessageQuote msg={reply} quoterIsAgent={false} memberProfiles={{ peer: member }} /></div>
  </>)
  const row = harness.container.querySelector<HTMLElement>('[data-message-sender-name]')!
  return { name: row.querySelector('.msg-sender-name')?.textContent, chip: row.querySelector('[data-message-agent-owner]'), quote: harness.container.querySelector('[data-testid="quote"]')?.textContent }
}

// #4028 (owner): a removed agent keeps its name on what it already said, marked removed, at rest; not only on hover.
it.each([
  { locale: 'zh-CN' as const, shown: 'Codex 1（已移除）' },
  { locale: 'en-US' as const, shown: 'Codex 1 (removed)' },
])('a removed agent\'s group message and a quote of it name it as $shown', async ({ locale, shown }) => {
  setLocalePreference(locale)
  const { name, chip, quote } = await render(agent('2026-11-27T01:00:00Z'))
  expect(name, 'the sender row says it at rest').toBe(shown)
  expect(chip, 'no hover-only chip repeats it').toBeNull()
  expect(quote, 'the quote head names it the same way').toContain(shown)
})

it('a live agent keeps its bare name and its hover owner chip', async () => {
  setLocalePreference('en-US')
  const { name, chip, quote } = await render(agent(null))
  expect(name).toBe('Codex 1')
  expect(chip).not.toBeNull()
  expect(quote).toContain('Codex 1')
  expect(quote).not.toContain('(removed)')
})
