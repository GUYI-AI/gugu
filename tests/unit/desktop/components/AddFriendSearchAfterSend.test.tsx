// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { AddFriendSearch } from '../../../../apps/desktop/src/components/AddFriendSearch'
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/imRepository', async (original) => ({
  ...await original<object>(),
  openedImRepository: async () => ({ putIdentities: async () => undefined }),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const submit = (input: HTMLInputElement) => act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

// 发出好友申请后:这一行留在原地,按钮变成「已发送申请」,下面说清对方在哪里看到 —— ❌ 不清空、不离开这一页
// (owner 11-22:发完整页变空只剩一个 toast,是「打击积极性」的那一下)。附言在行内展开,不再弹 Dialog。
describe('AddFriendSearch after a request is sent', () => {
  it('shows the real default name in fresh agent lookup results', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-11-02T08:00:00.000Z')
    vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([contact({ id: 'fresh', display_name: 'Codex 5', type: 'agent', agent_type: 'codex', created_at: '2026-11-02T08:00:00.000Z' })])
    await renderWithAppProviders(harness, createNode(AddFriendSearch, { onBack: vi.fn() }), {
      contacts: { contacts: [], sentRequests: [] },
    })
    const input = harness.container.querySelector('input')!
    await typeInto(input, 'Codex 5')
    await submit(input)
    await waitForCondition(() => harness.container.querySelector('.gg-row') !== null, 'no result row')
    expect(harness.container.querySelector('.gg-row')?.textContent).toContain('Codex 5')
    expect(harness.container.querySelector('.gg-row')?.textContent).not.toContain('正在生成名称…')
  })

  it('keeps the row where it was, marks it sent, and stays on the page', async () => {
    const sendRequest = vi.fn(async () => {})
    vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([contact({ id: 'bob', display_name: 'Bob' })])
    const onBack = vi.fn()
    await renderWithAppProviders(harness, createNode(AddFriendSearch, { onBack }), {
      contacts: { contacts: [], sentRequests: [], sendRequest },
    })

    const input = harness.container.querySelector('input') as HTMLInputElement
    await typeInto(input, 'Bob')
    await submit(input)
    await waitForCondition(() => harness.container.querySelector('[data-testid="friend-search-add"]') !== null, 'no result row')
    await clickElement(harness.container.querySelector('[data-testid="friend-search-add"]')!)
    const note = harness.container.querySelector('[data-testid="friend-request-note"] textarea') as HTMLTextAreaElement
    expect(note).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await clickElement(harness.container.querySelector('[data-testid="friend-request-send"]')!)

    await waitForCondition(() => harness.container.querySelector('[data-testid="friend-search-again"]') !== null, 'no next step after sending')
    expect(sendRequest).toHaveBeenCalledWith('bob', '')
    expect(onBack).not.toHaveBeenCalled()
    expect(input.value).toBe('Bob')
    expect(harness.container.querySelector('[data-testid="friend-search-result"]')?.textContent).toContain('Bob')
    expect(harness.container.querySelector('[data-testid="friend-request-note"]')).toBeNull()

    await clickElement(harness.container.querySelector('[data-testid="friend-search-again"]')!)
    expect(input.value).toBe('')
    expect(harness.container.querySelector('[data-testid="friend-search-result"]')).toBeNull()
  })

  it('says a failed send in the row and keeps the note for a retry', async () => {
    const sendRequest = vi.fn(async () => { throw new Error('network down') })
    vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([contact({ id: 'bob', display_name: 'Bob' })])
    await renderWithAppProviders(harness, createNode(AddFriendSearch, {}), {
      contacts: { contacts: [], sentRequests: [], sendRequest },
    })
    const input = harness.container.querySelector('input') as HTMLInputElement
    await typeInto(input, 'Bob')
    await submit(input)
    await waitForCondition(() => harness.container.querySelector('[data-testid="friend-search-add"]') !== null, 'no result row')
    await clickElement(harness.container.querySelector('[data-testid="friend-search-add"]')!)
    const note = harness.container.querySelector('[data-testid="friend-request-note"] textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(note, 'hello')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickElement(harness.container.querySelector('[data-testid="friend-request-send"]')!)
    await waitForCondition(() => harness.container.querySelector('[data-testid="friend-request-failed"]') !== null, 'failure not said in the row')
    expect(harness.container.querySelector('[data-testid="friend-request-failed"]')?.textContent).toContain('network down')
    expect((harness.container.querySelector('[data-testid="friend-request-note"] textarea') as HTMLTextAreaElement).value).toBe('hello')
  })
})
