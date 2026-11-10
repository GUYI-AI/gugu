// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { expectExit, frame, holdDialogExit } from '../../../support/dialogExit'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
let h: ReturnType<typeof createReactHarness>
let exit: ReturnType<typeof holdDialogExit>
beforeEach(() => { h = createReactHarness(); exit = holdDialogExit() })
afterEach(() => { h.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const providers = () => ({ auth: { id: 'owner-1' }, contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })], groupChats: [] }, chat: { chats: [] } })
async function back() { await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) }) }

for (const kind of ['group', 'friend'] as const) it(`chat list ${kind}: the actual menu owner keeps the sheet through dismissal`, async () => {
  await renderWithAppProviders(h, createNode(ChatListPanel, { mobile: true }), providers())
  await clickElement(q('chat-list-plus-button')); await frame()
  await clickElement(q(kind === 'group' ? 'plus-menu-create-group' : 'plus-menu-add-friend')); await frame()
  const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!
  await back()
  await expectExit(popup, exit)
})

it('chat group creation: selecting the new chat happens after the sheet exits', async () => {
  const selected = vi.fn()
  const setChat = vi.fn()
  const props = providers()
  await renderWithAppProviders(h, createNode(ChatListPanel, { mobile: true, onChatSelected: selected }), { ...props, chat: { ...props.chat, setActiveChatId: setChat } })
  await clickElement(q('chat-list-plus-button')); await frame()
  await clickElement(q('plus-menu-create-group')); await frame()
  const popup = q('create-group-modal')
  await clickElement(popup.querySelector('[data-contact-option="alice"]')!)
  const create = [...popup.querySelectorAll('button')].find((b) => /创建群聊|Create group/.test(b.textContent ?? ''))!
  await clickElement(create)
  expect(selected).not.toHaveBeenCalled()
  expect(setChat).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(selected).toHaveBeenCalledOnce()
  expect(setChat).toHaveBeenCalledWith('group-chat-1')
})
