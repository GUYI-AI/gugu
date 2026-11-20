import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import type { CapturedUnreadEntry } from '@/lib/chatUnreadLocator'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

// The 「↑ N 条新消息」 entry belongs to one opening, and the opening ends on the surface that presents it. On the desktop a group
// is a block of the session page: opening another group from the sidebar closes the block while the account's own observer of
// the first group lives on, so nothing but the presenting surface knows the reader left (the entry used to come back on return).
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined })

const group = chat({ id: 'group', kind: 'group', name: 'Group', unread_count: 0, next_message_seq: 41 })
const messages = Array.from({ length: 40 }, (_, i) => message({ id: `m${i + 1}`, seq: i + 1, chat_id: 'group', sender_user_id: 'sender',
  created_at: '2026-11-19T08:00:00Z', content: `Message ${i + 1}. ${'A long line in a busy group. '.repeat(i % 4 + 1)}` }))
const entryOf = (consume: () => void): CapturedUnreadEntry => ({ chatId: 'group', consume, locator: { stream_id: 'main:group', stream_kind: 'main',
  thread_root_id: null, message_id: 'm1', message_seq: 1, unread_count: 40, addressed_count: 0, cursor_seq: 0, version: 1, is_marked_unread: false,
  first_addressed_message_id: null, first_addressed_seq: null } })
const pill = () => harness!.container.querySelector('[data-unread-above]')
const settled = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)))

async function present(entry: CapturedUnreadEntry, view: { hidden?: boolean; strict?: boolean; gone?: boolean } = {}) {
  const panel = view.gone ? null : <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><ChatAreaPanel hidden={view.hidden} /></div>
  await renderWithAppProviders(harness!, view.strict ? <StrictMode>{panel}</StrictMode> : panel, { chat: {
    chats: [group], activeChat: group, activeChatId: 'group', messages, unreadEntry: entry, jumpToUnreadEntry: vi.fn(async () => {}) } })
}

it.each([
  { leave: 'the block closes', view: { gone: true } },
  { leave: 'the surface is hidden', view: { hidden: true } },
])('ends the opening\'s entry when $leave', async ({ view }) => {
  await page.viewport(1100, 700)
  harness = createReactHarness()
  const consume = vi.fn(), entry = entryOf(consume)
  await present(entry)
  await until('the first unread is above the landed tail and the pill shows', () => !!pill())
  await settled()
  expect(consume).not.toHaveBeenCalled()
  await present(entry, view)
  await until('leaving the conversation consumes the entry', () => consume.mock.calls.length > 0)
  expect(consume).toHaveBeenCalledOnce()
})

it('keeps the entry through a StrictMode remount of the same opening', async () => {
  await page.viewport(1100, 700)
  harness = createReactHarness()
  const consume = vi.fn()
  await present(entryOf(consume), { strict: true })
  await until('the pill shows', () => !!pill())
  await settled()
  expect(consume).not.toHaveBeenCalled()
})
