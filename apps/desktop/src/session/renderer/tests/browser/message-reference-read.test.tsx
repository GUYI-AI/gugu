import { afterEach, expect, it, vi } from 'vitest'
import { useMessageReference } from '@/components/chat/useMessageReference'
import type { MessageReferenceRead } from '@/lib/widgetRegistry'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

const state = vi.hoisted(() => ({ user: 'reader', read: (): Promise<MessageReferenceRead> => new Promise(() => {}), reads: 0,
  listeners: new Set<(operations: Array<{ payload: unknown }>) => void>() }))
vi.mock('@/lib/widgetRegistry', async original => ({ ...(await original<object>()), readMessageReference: () => { state.reads++; return state.read() } }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: state.user } }) }))
vi.mock('@/store/chatContext', async original => ({ ...(await original<object>()), useChatStore: () => ({ subscribeAccountRevision: (_events: unknown, listener: (operations: Array<{ payload: unknown }>) => void) => {
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
} }) }))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

function Card() {
  const read = useMessageReference({ kind: 'message', chatId: 'chat', messageId: 'message' })
  return <p data-read={read instanceof Error ? 'error' : read?.status ?? 'loading'} />
}
const shown = () => harness.container.querySelector('[data-read]')!.getAttribute('data-read')

it('shows a card mounted again with its last read in the first frame, and never to another account', async () => {
  state.read = async () => ({ status: 'unreadable' })
  harness = createReactHarness()
  await harness.render(<Card />)
  await until('the card is read once', () => shown() === 'unreadable')
  harness.cleanup()
  // Back in the conversation: the read is slow now, and the first frame must not show a loading card.
  state.read = () => new Promise(() => {})
  harness = createReactHarness()
  await harness.render(<Card />)
  expect(shown()).toBe('unreadable')
  harness.cleanup()
  state.user = 'other'
  harness = createReactHarness()
  await harness.render(<Card />)
  expect(shown()).toBe('loading')
})

it('reads a card again only for a change in the chat it quotes, not for every change of the account', async () => {
  state.user = 'reader'
  state.read = async () => ({ status: 'unreadable' })
  state.reads = 0
  harness = createReactHarness()
  await harness.render(<Card />)
  await until('the card is read once', () => state.reads === 1 && shown() === 'unreadable')
  const change = (chat_id: string) => { for (const listener of state.listeners) listener([{ payload: { chat_id } }]) }
  change('another-chat')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(state.reads).toBe(1)
  change('chat')
  await until('the quoted chat\'s change reads it again', () => state.reads === 2)
})
