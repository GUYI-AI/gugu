// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({ setComposerVerb: vi.fn(), chats: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { sessionHost: true } } }))
vi.mock('../../../../apps/desktop/src/lib/shellSlots', () => ({ useInChatSlot: () => true }))
vi.mock('../../../../apps/desktop/src/lib/composerVerbBridge', () => ({ setComposerVerb: mocks.setComposerVerb }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ chats: mocks.chats, identitiesById: { peer: { display_name: 'Ada' } } }),
}))
const { ComposerVerbs } = await import('../../../../apps/desktop/src/components/chat/ComposerVerbs')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); mocks.setComposerVerb.mockClear() })
afterEach(() => harness.cleanup())

it.each([
  [{ id: 'g', kind: 'group', name: 'Raw group', alias: 'Front-end' }, 'Front-end'],
  [{ id: 'g', kind: 'dm', name: '', peer_user_id: 'peer', peer_alias: null }, 'Ada'],
])('labels the new-task composer with the chat\'s shown name (%#)', async (chat, shown) => {
  mocks.chats = [chat]
  await harness.render(<ComposerVerbs chatId="g" isGroupChat draft={() => ''} onCarried={() => undefined} />)
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="composer-verb-task"]')!)
  expect(mocks.setComposerVerb.mock.calls[0]![3]).toMatchObject({ name: shown })
})
