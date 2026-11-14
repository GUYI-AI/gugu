import { afterEach, expect, it, vi } from 'vitest'
import { MessageReferenceContent } from '@/components/chat/MessageReferenceContent'
import type { MessageReferenceRead } from '@/lib/widgetRegistry'
import { createReactHarness, message } from '../../../../../../../tests/support/testHarness'

const state = vi.hoisted(() => ({ read: { status: 'unreadable' } as MessageReferenceRead, follow: vi.fn() }))
vi.mock('@/components/chat/useMessageReference', async original => ({ ...(await original<object>()), useMessageReference: () => state.read }))
vi.mock('@/components/chat/WidgetBubble', () => ({ WidgetBubble: () => <div data-unexpected-widget /> }))
vi.mock('@/lib/guguLinks', async original => ({ ...(await original<object>()), followLink: state.follow }))
vi.mock('@/store/chatContext', async original => ({ ...(await original<object>()), useChatStore: () => ({
  identitiesById: { sender: { id: 'sender', type: 'human', display_name: 'Visible author', avatar: null } },
  chats: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'group', name: 'Visible origin' }],
}) }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it('shows source metadata only after the viewer can read the original, and navigates to that original', async () => {
  harness = createReactHarness()
  const chatId = '11111111-1111-4111-8111-111111111111', messageId = '22222222-2222-4222-8222-222222222222'
  const origin = message({ id: messageId, chat_id: chatId, sender_user_id: 'sender', content: 'Authorized original body', created_at: '2026-11-02T10:00:00Z' })
  const view = () => <MessageReferenceContent content={`gugu-chat://${chatId}/${messageId}`} chatId="current" slotMessageId="quote" renderText={content => <p>{content}</p>} />
  state.read = { status: 'unreadable' }
  await harness.render(view())
  expect(harness.container.querySelector('[data-reference-unreadable]')).not.toBeNull()
  for (const text of ['Visible origin', 'Visible author', 'Authorized original body']) expect(harness.container.textContent).not.toContain(text)
  expect(harness.container.querySelector('time')).toBeNull()
  state.read = { status: 'readable', message: origin }
  await harness.render(view())
  for (const text of ['Visible origin', 'Visible author', 'Authorized original body']) expect(harness.container.textContent).toContain(text)
  expect(harness.container.querySelector('time')?.dateTime).toBe(origin.created_at)
  harness.container.querySelectorAll('button')[1]!.click()
  expect(state.follow).toHaveBeenCalledWith({ kind: 'chat', chatId, messageId })
  state.read = { status: 'retracted', widget: false }
  await harness.render(view())
  expect(harness.container.querySelector('[data-reference-retracted]')).not.toBeNull()
  for (const text of ['Visible origin', 'Visible author', 'Authorized original body']) expect(harness.container.textContent).not.toContain(text)
})
