import { afterEach, expect, it, vi } from 'vitest'
import { useMessageReference } from '@/components/chat/useMessageReference'
import type { MessageReferenceRead } from '@/lib/widgetRegistry'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { followRendererSession } from '@/lib/replica'

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

// The reads are account replicas: they follow the published session, which the product signs in with the same user.
const signIn = (user: string) => { state.user = user; followRendererSession('SIGNED_IN', user) }

function Card() {
  const read = useMessageReference({ kind: 'message', chatId: 'chat', messageId: 'message' })
  return <p data-read={read instanceof Error ? 'error' : read?.status ?? 'loading'} />
}
const shown = () => harness.container.querySelector('[data-read]')!.getAttribute('data-read')

it('shows a card mounted again with its last read in the first frame, and never to another account', async () => {
  signIn('reader')
  state.read = async () => ({ status: 'unreadable' })
  harness = createReactHarness()
  await harness.render(<Card />)
  await until('the card is read once', () => shown() === 'unreadable')
  harness.cleanup({ keepReads: true })
  // Back in the conversation: the read is slow now, and the first frame must not show a loading card.
  state.read = () => new Promise(() => {})
  harness = createReactHarness()
  await harness.render(<Card />)
  expect(shown()).toBe('unreadable')
  harness.cleanup({ keepReads: true })
  signIn('other')
  harness = createReactHarness()
  await harness.render(<Card />)
  expect(shown()).toBe('loading')
})
