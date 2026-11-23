// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanDmFriendshipNotice } from '../../../../apps/desktop/src/components/chat/HumanDmFriendshipNotice'
import { ContactsContext, type ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'
import { contact, contactsStore, createReactHarness, displayIdentity } from '../../../support/testHarness'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

let ui: ReturnType<typeof createReactHarness>
const toast = vi.fn()
const peer = displayIdentity('peer')
type Props = Parameters<typeof HumanDmFriendshipNotice>[0]
async function render(contacts: Partial<ContactsContextValue> = {}, props: Partial<Props> = {}) {
  await ui.render(<ToastContext.Provider value={{ toast }}>
    <ContactsContext.Provider value={contactsStore(contacts)}>
      <HumanDmFriendshipNotice chatId="old-dm" kind="dm" currentUserId="owner" peer={peer} {...props} />
    </ContactsContext.Provider>
  </ToastContext.Provider>)
}
beforeEach(() => { setLocalePreference('zh-CN'); toast.mockReset(); ui = createReactHarness() })
afterEach(() => ui.cleanup())

describe('the shared human DM stream notice', () => {
  it('uses the existing system line and sends directly to the peer, with no greeting or dialog', async () => {
    const sendRequest = vi.fn(async () => {})
    await render({ sendRequest })
    expect(ui.container.textContent).toBe('对方尚未成为你的好友 添加好友')
    expect(ui.container.querySelector('.system-message-notice > span')).not.toBeNull()
    await act(async () => { ui.container.querySelector('button')!.click() })
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith('peer')
    expect(toast).toHaveBeenCalledExactlyOnceWith('好友申请已发送', 'success')
    expect(ui.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each(['idle', 'loading', 'error'] as const)('does not infer nonfriendship from a %s contacts snapshot', async contactsStatus => {
    await render({ contactsStatus })
    expect(ui.container.textContent).toBe('')
  })

  it('waits for an authoritative refresh and disappears when the peer becomes a friend', async () => {
    await render({ loadingContacts: true })
    expect(ui.container.textContent).toBe('')
    await render()
    expect(ui.container.querySelector('button')).not.toBeNull()
    await render({ contacts: [contact({ id: 'peer' })] })
    expect(ui.container.textContent).toBe('')
  })

  it.each([
    { kind: 'group' as const },
    { peer: displayIdentity('agent', { type: 'agent' }) },
    { peer: undefined },
    { peer: displayIdentity('owner') },
    { currentUserId: null },
  ])('does not label an out-of-scope conversation as a nonfriend DM (%j)', async props => {
    await render({}, props)
    expect(ui.container.textContent).toBe('')
  })

  it('keeps a pending request visible without sending it twice', async () => {
    const sendRequest = vi.fn(async () => {})
    await render({ sendRequest, sentRequests: [{ id: 'request', sender_id: 'owner', receiver_id: 'peer', status: 'pending', message: null, created_at: '2026-11-19T00:00:00Z' }] })
    const button = ui.container.querySelector('button')!
    expect(button.textContent).toBe('已发送')
    await act(async () => { button.click() })
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('blocks duplicate clicks while the request is in flight and allows retry after failure', async () => {
    let reject!: (reason: unknown) => void
    const sendRequest = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    await render({ sendRequest })
    const button = ui.container.querySelector('button')!
    await act(async () => { button.click(); button.click() })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(button.textContent).toBe('发送中…')
    await act(async () => { reject(new Error('dm_friendship_required')) })
    expect(toast).toHaveBeenCalledExactlyOnceWith('发送失败：请先添加对方为好友，再发送消息。', 'error')
    expect(button.textContent).toBe('添加好友')
    expect(ui.container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { button.click() })
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await act(async () => { reject(new Error('offline')) })
  })

  it.each([{ currentUserId: 'other-owner' }, { chatId: 'other-dm', peer: displayIdentity('other-peer') }])('ignores late request outcomes after switching scope (%j)', async props => {
    let reject!: (reason: unknown) => void
    const sendRequest = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
    await render({ sendRequest })
    await act(async () => { ui.container.querySelector('button')!.click() })
    await render({ sendRequest }, props)
    await act(async () => { reject(new Error('old-scope failure')) })
    expect(toast).not.toHaveBeenCalled()
    expect(ui.container.querySelector('button')!.textContent).toBe('添加好友')
  })

  it('localizes the same notice in English', async () => {
    setLocalePreference('en-US')
    await render()
    expect(ui.container.textContent).toBe('This person is not your friend yet. Add friend')
  })
})
