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

// 发出好友申请后：离开这一页（onBack：弹窗关掉 / 手机整页返回），搜索框与结果清空，不再留着上一次的输入。
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
  it('clears the query and results, then hands back to the host', async () => {
    const sendRequest = vi.fn(async () => {})
    vi.spyOn(contactsService, 'searchUsers').mockResolvedValue([contact({ id: 'bob', display_name: 'Bob' })])
    const onBack = vi.fn()
    await renderWithAppProviders(harness, createNode(AddFriendSearch, { onBack }), {
      contacts: {
        contacts: [],
        sentRequests: [],
        sendRequest,
      },
    })

    const input = harness.container.querySelector('input') as HTMLInputElement
    await typeInto(input, 'Bob')
    await submit(input)
    await waitForCondition(() => harness.container.querySelector('.gg-row button') !== null, 'no result row')
    const addButton = Array.from(harness.container.querySelectorAll('.gg-row button'))[0] as HTMLButtonElement
    await clickElement(addButton)

    // 附言框下面那一行是「取消 / 发送」;Sheet 自己还有一个关闭钮,所以按行取,❌ 取整个弹窗的最后一个按钮。
    const dialog = document.body.querySelector('[data-testid="friend-request-note-dialog"]') as HTMLElement
    const actions = dialog.querySelector('textarea')?.nextElementSibling as HTMLElement
    const send = [...actions.querySelectorAll('button')].pop() as HTMLButtonElement
    await clickElement(send)

    await waitForCondition(() => onBack.mock.calls.length === 1, 'onBack not called')
    expect(sendRequest).toHaveBeenCalledWith('bob', '')
    expect(input.value).toBe('')
    expect(harness.container.querySelector('.gg-row')).toBeNull()
  })
})
