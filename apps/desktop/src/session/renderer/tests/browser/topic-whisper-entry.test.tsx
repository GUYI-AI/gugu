import { afterEach, it, onTestFinished, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { chat, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import '@/i18n/registerContactsCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

const { chatService } = await import('@/lib/chat')
const { openImRepository } = await import('@/lib/imRepository')
const { createMemoryLocalSyncDb } = await import('@/lib/localSyncDb')

// A whisper is decided per message by the backend, whatever the conversation (a group or one of its topics): a card opened
// on a message in a topic offers Whisper to that topic's participants, and choosing it puts the composer in whisper mode.
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined; vi.mocked(chatService.getGroupCollab).mockReset() })

const frames = (n: number) => new Promise<void>((resolve) => { const step = (k: number) => k <= 0 ? setTimeout(resolve) : requestAnimationFrame(() => step(k - 1)); step(n) })
async function until<T>(read: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) { const value = read(); if (value) return value; await frames(2) }
  throw new Error(`timed out waiting for ${what}: ${(document.querySelector('[data-testid="message-avatar-profile-menu"]') ?? document.querySelector('[data-msg-id="m1"]') ?? document.body).textContent?.slice(0, 600)}`)
}

it.each(['topic', 'group'] as const)('a card opened on a message in a %s offers Whisper, which puts the composer in whisper mode', async (kind) => {
  await page.viewport(1100, 800)
  harness = createReactHarness()
  const repository = await openImRepository('owner', { adapter: createMemoryLocalSyncDb() })
  onTestFinished(() => repository.close())
  const room = chat(kind === 'topic'
    ? { id: 'topic-1', kind: 'topic', name: 'Plans', source_chat_id: 'group-1' }
    : { id: 'group-1', kind: 'group', name: 'Team' })
  vi.mocked(chatService.getGroupCollab).mockImplementation((async () => ({
    snapshot: { scheduler: { chat_id: room.id, paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-11-25T00:00:00.000Z' },
      humans: [{ id: 'owner', role: 'owner', type: 'human', account_status: null }, { id: 'mate', role: 'member', type: 'human', account_status: null }],
      agents: [], tasks: [] },
    identities: [displayIdentity('owner', { display_name: 'Owner' }), displayIdentity('mate', { display_name: 'Mate' })],
  })) as never)
  const messages = [message({ id: 'm1', seq: 1, chat_id: room.id, sender_user_id: 'mate', content: 'hello from mate', created_at: '2026-11-25T08:00:00Z' })]
  await renderWithAppProviders(harness, <div style={{ height: 760, display: 'flex', flexDirection: 'column' }}><ChatAreaPanel /></div>, {
    auth: { id: 'owner' },
    chat: { chats: [room, ...(kind === 'topic' ? [chat({ id: 'group-1', kind: 'group', name: 'Team' })] : [])], activeChat: room, activeChatId: room.id, messages, getImRepository: async () => repository,
      identitiesById: { owner: displayIdentity('owner', { display_name: 'Owner' }), mate: displayIdentity('mate', { display_name: 'Mate' }) } },
  })
  const avatar = await until(() => document.querySelector<HTMLElement>('[data-msg-id="m1"] [data-testid="message-avatar-profile-button"]'), 'the message avatar')
  avatar.click()
  const card = await until(() => document.querySelector<HTMLElement>('[data-testid="message-avatar-profile-menu"]'), 'the profile card')
  const whisper = await until(() => [...card.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent?.trim() === 'Whisper'), 'the Whisper action')
  whisper.click()
  await until(() => document.body.textContent?.includes('Whisper to Mate, visible only to you both.'), 'the whisper band')
})
