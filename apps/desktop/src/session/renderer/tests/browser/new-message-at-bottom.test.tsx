import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { ChatHistoryWindow } from '@/store/chatHistoryWindow'
import { chat, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@/platform', () => import('../../../../../../../tests/support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', async original => ({ ...await original<object>(), ...await import('../../../../../../../tests/support/contactsChatServiceTestDouble') }))
vi.mock('@/lib/topics', async original => ({ ...await original<object>(), topicService: { listTopicsOfChat: vi.fn(async () => []) } }))

// A reader resting at the bottom of a conversation is following it: a message that arrives there is read, never counted
// into 「N new messages ↓」. The panel runs against the real history window, which counts arrivals while it is told the
// reader is not following.
let harness: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { harness?.cleanup(); harness = undefined })

const frames = (n: number) => new Promise<void>((resolve) => { const step = (k: number) => k <= 0 ? setTimeout(resolve) : requestAnimationFrame(() => step(k - 1)); step(n) })
const rowsOf = (chatId: string) => Array.from({ length: 40 }, (_, i) => message({ id: `${chatId}-m${i + 1}`, seq: i + 1, chat_id: chatId, sender_user_id: 'sender',
  created_at: '2026-11-19T08:00:00Z', content: `Message ${i + 1}. ${'A long line in a busy group. '.repeat(i % 4 + 1)}` }))

function conversations() {
  const chats = { group: chat({ id: 'group', kind: 'group', name: 'Group' }), other: chat({ id: 'other', kind: 'group', name: 'Other' }) }
  const windows = { group: new ChatHistoryWindow(), other: new ChatHistoryWindow() }
  windows.group.reset('group', rowsOf('group'))
  windows.other.reset('other', rowsOf('other'))
  // The store hands the panel one stable setter per conversation.
  const follow = { group: (f: boolean | undefined) => { if (f !== undefined) windows.group.setFollowingTail(f) }, other: (f: boolean | undefined) => { if (f !== undefined) windows.other.setFollowingTail(f) } }
  let active: keyof typeof chats = 'group', height = 600
  const present = async () => {
    const snap = windows[active].getSnapshot()
    await renderWithAppProviders(harness!, <div style={{ height, display: 'flex', flexDirection: 'column' }}><ChatAreaPanel /></div>, { chat: {
      chats: Object.values(chats), activeChat: chats[active], activeChatId: active, messages: snap.messages, messageWindow: snap, setFollowingTail: follow[active] } })
  }
  let rendered = Promise.resolve()
  for (const win of Object.values(windows)) win.subscribe(() => { rendered = rendered.then(present) })
  let seq = 41
  return {
    present,
    rendered: () => rendered,
    open: async (id: keyof typeof chats, viewportHeight = height) => { active = id; height = viewportHeight; await present() },
    arrive: () => { const n = seq++; windows.group.update((rows) => [...rows, message({ id: `group-m${n}`, seq: n, chat_id: 'group', sender_user_id: 'agent',
      created_at: '2026-11-19T08:01:00Z', content: `Arrived ${n}. ${'Reply text. '.repeat(30)}` })]) },
    scroller: () => harness!.container.querySelector<HTMLElement>('[data-unread-stream-surface="main"]')!,
    gap() { const s = this.scroller(); return s.scrollHeight - s.clientHeight - s.scrollTop },
    notice: () => harness!.container.textContent?.match(/\d+ new messages? ↓/)?.[0] ?? null,
    counted: () => windows.group.getSnapshot().newMessageCount,
  }
}

it('reads arrivals at the bottom without counting them', async () => {
  await page.viewport(1100, 700)
  harness = createReactHarness()
  const c = conversations()
  await c.present()
  await frames(4)
  for (let i = 0; i < 3; i++) { c.arrive(); await c.rendered(); await frames(3) }
  expect(c.gap()).toBeLessThan(2)
  expect(c.counted()).toBe(0)
  expect(c.notice()).toBeNull()
})

it('stays at the bottom when the newest message grows after it is painted (a picture decoding late)', async () => {
  await page.viewport(1100, 700)
  harness = createReactHarness()
  const c = conversations()
  await c.present()
  await frames(4)
  // The picture lands in a task between the arrival's paint and the list's next reading: the window that used to be
  // folded into the list's baseline, so the growth was never followed and the next arrival was counted.
  requestAnimationFrame(() => setTimeout(() => {
    const picture = document.createElement('div')
    picture.style.height = '320px'
    c.scroller().querySelector('[data-msg-id="group-m41"]')!.appendChild(picture)
  }))
  c.arrive(); await c.rendered(); await frames(4)
  expect(c.gap()).toBeLessThan(2)
  c.arrive(); await c.rendered(); await frames(3)
  expect(c.gap()).toBeLessThan(2)
  expect(c.counted()).toBe(0)
  expect(c.notice()).toBeNull()
})

it('follows again when a saved reading position restores onto the bottom', async () => {
  await page.viewport(1100, 900)
  harness = createReactHarness()
  const c = conversations()
  await c.present()
  await frames(4)
  // The reader rests just past the at-bottom threshold and leaves; the conversation comes back in a taller viewport, so
  // the saved row cannot sit at its offset and the restore settles on the bottom.
  c.scroller().scrollTop -= 120
  await frames(4)
  await c.open('other'); await frames(4)
  await c.open('group', 800); await frames(12)
  await new Promise((resolve) => setTimeout(resolve, 300)); await frames(4)
  expect(c.gap()).toBeLessThan(2)
  c.arrive(); await c.rendered(); await frames(4)
  expect(c.gap()).toBeLessThan(2)
  expect(c.counted()).toBe(0)
  expect(c.notice()).toBeNull()
})

it('still counts arrivals for a reader who rests in history', async () => {
  await page.viewport(1100, 700)
  harness = createReactHarness()
  const c = conversations()
  await c.present()
  await frames(4)
  c.scroller().scrollTop -= 400
  await frames(4)
  c.arrive(); await c.rendered(); await frames(3)
  expect(c.gap()).toBeGreaterThan(80)
  expect(c.counted()).toBe(1)
  expect(c.notice()).toBe('1 new message ↓')
})
