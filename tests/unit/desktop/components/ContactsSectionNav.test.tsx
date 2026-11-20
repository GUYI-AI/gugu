// @vitest-environment jsdom
// 桌面通讯录:左栏只列分组(一行一个、带计数,❌ 折叠展开);点一个分组,右边大区域铺开这一组的全部联系人,
// agent 按派生关系画成导图(AgentMindMap)。计数与右边铺开的是同一份分组;分组全空时给空态 CTA。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const parents = vi.hoisted(() => new Map<string, string>())
vi.mock('../../../../apps/desktop/src/components/contacts/contactsAgentTree', async (importOriginal) => ({
  ...(await importOriginal<object>()), useAgentParents: () => parents,
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); parents.clear() })
afterEach(() => { harness.cleanup() })

const agent = (id: string, name: string) => contact({ id, type: 'agent', display_name: name, owner_user_id: 'owner-1', device_id: null })
async function render(contacts: ReturnType<typeof contact>[], groupChats: { id: string; name: string; member_user_ids: string[] }[] = [], props = {}) {
  await renderWithAppProviders(harness, createNode(ContactsPanel, props), { shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts, groupChats: groupChats.map((g) => ({ kind: 'group' as const, avatar_url: null, member_count: g.member_user_ids.length, is_muted: false, ...g })) },
    chat: { chats: [] },
  })
}
const $ = (selector: string) => harness.container.querySelector(selector) as HTMLElement | null
const nav = (key: string) => $(`[data-testid="contacts-section-nav"][data-section-key="${key}"]`)!
const pane = () => $('[data-testid="contacts-section-pane"]')!
const shownIds = () => [...pane().querySelectorAll<HTMLElement>('[data-contact-id], [data-group-id]')].map((row) => row.dataset.contactId ?? row.dataset.groupId)

describe('contacts page: groups on the left, the chosen group spread on the right', () => {
  it('lists each group once with its count, nothing folds, and the right area shows exactly what the count says', async () => {
    await render(
      [agent('arch', '架构师'), contact({ id: 'alice', display_name: 'Alice' })],
      [{ id: 'project', name: 'Project', member_user_ids: ['owner-1', 'arch'] }, { id: 'family', name: 'Family', member_user_ids: ['owner-1', 'alice'] }],
    )
    const keys = [...harness.container.querySelectorAll<HTMLElement>('[data-testid="contacts-section-nav"]')].map((row) => row.dataset.sectionKey)
    expect(keys).toEqual(['unknown', 'people', 'groups'])
    expect(harness.container.querySelector('[data-slot="collapse-panel"]')).toBeNull()
    // 设备分组 = 它的 agent + 我的 agent 在里面的群
    expect(nav('unknown').textContent).toContain('2')
    expect(nav('unknown').hasAttribute('data-selected')).toBe(true)
    expect(shownIds().sort()).toEqual(['arch', 'project'])
    await clickElement(nav('people'))
    expect(nav('people').hasAttribute('data-selected')).toBe(true)
    expect(shownIds()).toEqual(['alice'])
    await clickElement(nav('groups'))
    expect(shownIds()).toEqual(['family'])
    for (const id of [AUTOMATION_TEST_IDS.contactsPersonEmpty, AUTOMATION_TEST_IDS.contactsGroupEmpty, AUTOMATION_TEST_IDS.contactsAgentEmpty]) {
      expect($(`[data-testid="${id}"]`)).toBeNull()
    }
  })

  it('draws agents as a mind map: one curve per parent → child, single agents in the grid after the families', async () => {
    parents.set('front', 'arch').set('review', 'arch').set('css', 'front')
    await render([agent('arch', '架构师'), agent('front', '前端设计'), agent('review', '代码评审'), agent('css', '样式整理'), agent('solo', '翻译助手')])
    expect(pane().querySelectorAll('[data-testid="agent-family-map"]')).toHaveLength(1)
    expect(pane().querySelectorAll('[data-testid="agent-family-map"] [data-map-edges] path')).toHaveLength(3)
    // 家族图在前(先序:父在子前),单个 agent 在后
    expect(shownIds()).toEqual(['arch', 'front', 'css', 'review', 'solo'])
    await clickElement(pane().querySelector('[data-contact-id="front"]') as HTMLElement)
    expect($('[data-testid="contacts-detail-drawer"] [data-slot="pane-header"]')?.textContent).toBe('前端设计')
  })

  it('keeps the empty-state calls to action when every group is empty', async () => {
    await render([])
    await clickElement(nav('people'))
    expect($(`[data-testid="${AUTOMATION_TEST_IDS.contactsPersonEmpty}"]`)).toBeTruthy()
    await clickElement(nav('groups'))
    expect($(`[data-testid="${AUTOMATION_TEST_IDS.contactsGroupEmpty}"]`)).toBeTruthy()
  })

  it('opening a contact from elsewhere switches the left column to its group and opens it', async () => {
    await render([agent('arch', '架构师'), contact({ id: 'alice', display_name: 'Alice' })], [], { externalContactId: 'alice' })
    expect(nav('people').hasAttribute('data-selected')).toBe(true)
    expect($('[data-testid="contacts-detail-drawer"] [data-slot="pane-header"]')?.textContent).toBe('Alice')
  })
})
