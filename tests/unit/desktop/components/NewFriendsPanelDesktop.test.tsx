// @vitest-environment jsdom
// 桌面「新的请求」:与分组页同一副版式(页头 + 计数、右边抽屉)。三类请求按节排(好友 / Agent / 群聊,有才出),❌ 页签;
// 单列,行尾只放一样东西:等我处理的是「忽略 · 同意」(次要在左、主要在右,同全产品的确认框),其余是灰字状态。
// 点一行在右边抽屉里看详情,抽屉底部是同样次序的同一对操作;那一行同时高亮。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewFriendsPanel } from '../../../../apps/desktop/src/components/NewFriendsPanel'
import { friendRequestEntries } from '../../../../apps/desktop/src/lib/requestHistory'
import type { FriendRequest } from '../../../../packages/core/src/shared/types/contacts'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const me = contact({ id: 'me', display_name: '我' })
const myAgent = contact({ id: 'my-agent', type: 'agent', display_name: '前端设计', owner_user_id: 'me' })
const peer = (id: string, name: string) => contact({ id, display_name: name, gugu_number: 200123 })
const req = (id: string, from: ReturnType<typeof contact>, to: ReturnType<typeof contact>, status: FriendRequest['status'], message: string | null = null): FriendRequest =>
  ({ id, sender_id: from.id, receiver_id: to.id, sender: from, receiver: to, message, status, created_at: '2026-11-20T04:00:00Z' })
const received = [
  req('zoe', peer('p-zoe', 'Zoe 周'), me, 'pending', '想拉你进评审群'),
  req('tom', peer('p-tom', '汤姆'), myAgent, 'pending'),
  req('bob', peer('p-bob', '鲍勃'), me, 'accepted'),
]
const sent = [req('ann', me, peer('p-ann', 'Ann'), 'pending', '上次会上聊过')]
const $ = (selector: string) => harness.container.querySelector(selector) as HTMLElement | null
const kinds = () => [...harness.container.querySelectorAll<HTMLElement>('[data-request-kind]')].map((section) => section.dataset.requestKind)
const row = (name: string) => [...harness.container.querySelectorAll<HTMLElement>('.nfp-reqrow')].find((element) => element.textContent?.includes(name))!
const buttons = (element: HTMLElement) => [...element.querySelectorAll('button')].map((button) => button.textContent)

describe('new requests on desktop: sections, single column, drawer', () => {
  it('lays the requests out in sections, no tabs, with the pending count in the header', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: friendRequestEntries(received, sent) } })
    expect(harness.container.querySelector('[role="tab"]')).toBeNull()
    expect(kinds()).toEqual(['f', 'a'])
    expect($('[data-testid="new-requests"] [data-slot="pane-header"]')?.textContent).toContain('2 个待处理')
    expect(buttons(row('Zoe 周'))).toEqual(['忽略', '同意'])
    expect(row('Ann').textContent).toContain('等待验证')
    expect(buttons(row('Ann'))).toEqual([])
    expect(row('汤姆').closest('[data-request-kind]')?.getAttribute('data-request-kind')).toBe('a')
  })

  it('opens the detail in the drawer with the same actions in the same order, highlights the row, and closes after deciding', async () => {
    const acceptRequest = vi.fn(async () => ({ chatId: null, name: null, kind: null, created: false, member_count: null }))
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: friendRequestEntries(received, sent), acceptRequest } })
    await clickElement(row('Zoe 周'))
    const detail = $('[data-testid="contacts-detail-drawer"] [data-testid="request-detail"]')!
    expect(detail.textContent).toContain('想拉你进评审群')
    expect(detail.textContent).toContain('200123')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(row('Zoe 周').hasAttribute('data-selected')).toBe(true)
    expect(buttons(detail).filter((label) => label === '忽略' || label === '同意')).toEqual(['忽略', '同意'])
    await clickElement([...detail.querySelectorAll('button')].find((button) => button.textContent === '同意')!)
    expect(acceptRequest).toHaveBeenCalledWith('zoe')
    expect($('[data-testid="request-detail"]')).toBeNull()
  })

  it('says so when there is nothing at all', async () => {
    await renderWithAppProviders(harness, createNode(NewFriendsPanel, {}), { contacts: { friendRequests: [] } })
    expect(kinds()).toEqual([])
    expect($('[data-testid="new-requests"]')?.textContent).toContain('没有新的请求')
  })
})
