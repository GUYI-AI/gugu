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

// An opening lands at the latest message with 「↑ N new messages」 for the first unread above. The tail reconcile that follows
// replaces the window's view (a new scroller element) while the first unread keeps its place in the rows. Scrolling the new
// scroller up to that message must still end the pill: it used to keep listening to the scroller it first saw.
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined })

const group = chat({ id: 'group', kind: 'group', name: 'Group', unread_count: 0, next_message_seq: 41 })
const messages = Array.from({ length: 40 }, (_, i) => message({ id: `m${i + 1}`, seq: i + 1, chat_id: 'group', sender_user_id: 'sender',
  created_at: '2026-11-19T08:00:00Z', content: `Message ${i + 1}. ${'A long line in a busy group. '.repeat(i % 4 + 1)}` }))
const entryOf = (consume: () => void): CapturedUnreadEntry => ({ chatId: 'group', consume, locator: { stream_id: 'main:group', stream_kind: 'main',
  thread_root_id: null, message_id: 'm20', message_seq: 20, unread_count: 21, addressed_count: 0, cursor_seq: 19, version: 1, is_marked_unread: false,
  first_addressed_message_id: null, first_addressed_seq: null } })
const pill = () => harness!.container.querySelector('[data-unread-above]')
const scroller = () => harness!.container.querySelector<HTMLElement>('[data-unread-stream-surface="main"]')!

async function present(entry: CapturedUnreadEntry, viewVersion: number) {
  await renderWithAppProviders(harness!, <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><ChatAreaPanel /></div>, { chat: {
    chats: [group], activeChat: group, activeChatId: 'group', messages, unreadEntry: entry, jumpToUnreadEntry: vi.fn(async () => {}),
    messageWindow: { viewVersion, hasNewer: false, hasOlder: false, loading: null, change: 'latest' } as never } })
}

it.each([390, 1100])('ends the pill when the first unread is scrolled into a remounted scroller at width %i', async (width) => {
  await page.viewport(width, 700)
  harness = createReactHarness()
  const consume = vi.fn(), entry = entryOf(consume)
  await present(entry, 1)
  await until('the first unread is above the landed tail and the pill shows', () => !!pill())
  const first = scroller()
  await present(entry, 2)
  await until('the new view mounted its own scroller', () => scroller() !== first && !first.isConnected)
  // Scroll up the way a reader does, a screen at a time, until the first unread is on screen.
  const onScreen = () => {
    const row = scroller().querySelector<HTMLElement>('[data-msg-id="m20"]')?.getBoundingClientRect(), view = scroller().getBoundingClientRect()
    return !!row && row.bottom > view.top && row.top < view.bottom
  }
  await until('scrolling up brings the first unread on screen', () => {
    if (onScreen()) return true
    scroller().scrollTop -= 150
    return false
  })
  expect(scroller() !== first).toBe(true)
  await until('seeing the first unread ends the pill', () => !pill() && consume.mock.calls.length > 0)
})
