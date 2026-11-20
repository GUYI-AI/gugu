// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, contact, contactsStore, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
// 快捷键要等用户的按键设置读到才绑(getEffectiveHotkey):这里给一份已读到、没有改过的设置,⌘F 就是默认的 Mod+F。
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  Element.prototype.scrollIntoView = vi.fn() // jsdom 没有 scrollIntoView
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

const people = [
  contact({ id: 'zs', display_name: '张三', gugu_number: 109591 }),
  contact({ id: 'ls', display_name: '李四', alias: '老李', gugu_number: 109592 }),
  contact({ id: 'alan', display_name: 'Alan' }),
  contact({ id: 'alba', display_name: 'Alba' }),
  contact({ id: 'albot', display_name: 'Albot', type: 'agent', owner_user_id: 'owner-1', device_id: null }),
]
const groups = [
  { id: 'g1', kind: 'group' as const, name: 'Alpha Team', public_id: 208864, avatar_url: null, member_count: 2, is_muted: false, member_user_ids: ['owner-1', 'zs'] },
]

async function render(options: { mobile?: boolean; contacts?: Parameters<typeof contactsStore>[0] } = {}) {
  const onOpenGroupChat = vi.fn()
  await renderWithAppProviders(harness, createNode(ContactsPanel, { mobile: options.mobile ?? false, onOpenGroupChat }), { shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts: people, groupChats: groups, ...options.contacts },
    chat: { chats: [] },
  })
  return { onOpenGroupChat }
}
const $ = (selector: string) => harness.container.querySelector(selector) as HTMLElement | null
const input = () => $(`[data-testid="${AUTOMATION_TEST_IDS.contactsSearchInput}"]`) as HTMLInputElement
const results = () => $('[data-testid="contacts-search-results"]')
// 桌面:结果铺在右边;人和群是行([data-search-hit]),设备分组里的 agent 是导图节点([data-contact-id])。
const hits = () => Array.from(results()?.querySelectorAll<HTMLElement>('[data-search-hit], [data-contact-id]') ?? [])
const titles = () => hits().map((hit) => (hit.querySelector('.gg-list-row-title') ?? hit.querySelector('[data-map-name]'))?.textContent)
const sections = () => Array.from(results()?.querySelectorAll('[data-slot="section-label"]') ?? []).map((label) => label.textContent)
const subtitle = (index: number) => hits()[index]?.querySelector('.gg-list-row-subtitle')?.textContent
const drawerTitle = () => $('[data-testid="contacts-detail-drawer"] [data-slot="pane-header"]')?.textContent ?? ''
// 手机首页:结果表在原地顶替菜单(ContactSearch),详情是整页。
const rows = () => Array.from(results()?.querySelectorAll<HTMLElement>('[data-search-row]') ?? [])
const rowTitles = () => rows().map((row) => row.querySelector('.gg-list-row-title')?.textContent)
const detailTitle = () => $('[data-slot="pane"][data-role="detail"] [data-slot="pane-header"]')?.textContent ?? ''
const browseHidden = () => $('[data-testid="contacts-browse"]')?.className === 'hidden'
const press = (key: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

describe('contacts search (desktop: box in the left column, results in the right area)', () => {
  it('finds by the real name while the opened agent shows the naming placeholder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-11-02T08:00:00.000Z')
    await render({ contacts: { contacts: [contact({ id: 'fresh', display_name: 'Codex 5', type: 'agent', agent_type: 'codex', owner_user_id: 'owner-1', created_at: '2026-11-02T08:00:00.000Z' })] } })
    await typeInto(input(), 'codex5')
    expect(titles()).toEqual(['Codex 5'])
    await press('Enter')
    expect(drawerTitle()).toBe('正在生成名称…')
  })

  it('replaces the right area with results grouped like the left column, and gives the group page back on clear', async () => {
    await render()
    expect(results()).toBeNull()
    expect($('[data-testid="contacts-section-pane"]')).toBeTruthy()

    await typeInto(input(), 'zs')
    expect(sections()).toEqual(['个人 · 1'])
    expect(titles()).toEqual(['张三'])
    expect($('[data-testid="contacts-section-pane"]')).toBeNull()
    // 左栏的分组照旧在,搜索时哪一组都不亮
    expect($('[data-testid="contacts-section-nav"][data-selected]')).toBeNull()

    await typeInto(input(), 'xyz')
    expect(hits()).toHaveLength(0)
    expect(results()?.textContent).toContain('没有找到「xyz」')

    await clickElement($('[aria-label="清除搜索"]')!)
    expect(input().value).toBe('')
    expect(results()).toBeNull()
    expect($('[data-testid="contacts-section-pane"]')).toBeTruthy()
  })

  it('marks the hit characters by ink fill: hits full, the rest muted', async () => {
    await render({ contacts: { contacts: [...people, contact({ id: 'yj', display_name: '𠮷野家' })] } })
    const segments = () => Array.from(hits()[0].querySelectorAll('.gg-list-row-title span')).map((span) => [span.textContent, span.className])
    await typeInto(input(), 'lan')
    expect(segments()).toEqual([['A', 'text-[var(--muted-fg)]'], ['lan', 'text-[var(--fg)]']])
    await typeInto(input(), 'alan')
    expect(segments()).toEqual([['Alan', 'text-[var(--fg)]']])
    // 代理对不被切开
    await typeInto(input(), '𠮷')
    expect(segments()).toEqual([['𠮷', 'text-[var(--fg)]'], ['野家', 'text-[var(--muted-fg)]']])
  })

  it('says why a row matched when the hit is not in the shown name', async () => {
    await render()
    await typeInto(input(), '李四')
    expect(titles()).toEqual(['老李'])
    expect(subtitle(0)).toBe('原名 李四')
    await typeInto(input(), '109592')
    expect(subtitle(0)).toBe('咕咕号 109592')
    await typeInto(input(), '208864')
    expect(sections()).toEqual(['群组 · 1'])
    expect(subtitle(0)).toBe('群号 208864')
  })

  it('moves with arrows in on-screen order and opens on Enter: switches to that group, selects, opens the drawer', async () => {
    await render()
    await typeInto(input(), 'al')
    // 分组次序同左栏:设备分组(没有设备表时是通用「Agent」)在前,然后个人、群组
    expect(sections()).toEqual(['Agent · 1', '个人 · 2', '群组 · 1'])
    expect(titles()).toEqual(['Albot', 'Alan', 'Alba', 'Alpha Team'])
    expect(hits()[0].hasAttribute('data-selected')).toBe(true)
    expect(drawerTitle()).toBe('')

    await press('ArrowDown')
    await press('ArrowDown')
    expect(hits()[2].hasAttribute('data-selected')).toBe(true)
    await press('Enter')
    expect(results()).toBeNull()
    expect(input().value).toBe('')
    expect($('[data-testid="contacts-section-nav"][data-selected]')?.dataset.sectionKey).toBe('people')
    expect(drawerTitle()).toBe('Alba')
  })

  it('offers a 咕咕号 lookup when a number finds nobody, and seeds the add-contact search with it', async () => {
    const searchUsers = vi.fn(async () => {})
    await render({ contacts: { searchUsers } })
    await typeInto(input(), '109601')
    expect(results()?.textContent).toContain('用咕咕号 109601 查找')
    await press('Enter')
    expect(searchUsers).toHaveBeenCalledWith('109601')
  })

  it('ticks a person instead of opening them while picking people for a new group, and keeps the query', async () => {
    await render()
    await clickElement($(`[data-testid="${AUTOMATION_TEST_IDS.contactsSelectModeButton}"]`)!)
    await typeInto(input(), '张')
    await clickElement(hits()[0])
    expect(hits()[0].getAttribute('aria-pressed')).toBe('true')
    expect(input().value).toBe('张')
    expect(harness.container.textContent).toContain('已选 1 人')
  })

  it('⌘F on the contacts page focuses this box, and finds people in other groups than the one open', async () => {
    await render()
    expect($('[data-testid="contacts-section-nav"][data-selected]')?.dataset.sectionKey).toBe('unknown')
    // 真按键(不是直接派发命令):通讯录 tab 上会话页的快捷键绑定器是卸掉的,当年就是派发命令能过、真按不行。
    // Mod = 平台的命令键,jsdom 里平台不定,两种都按一次。
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, ...mod })) })
    }
    expect(document.activeElement).toBe(input())
    await typeInto(input(), '张三')
    expect(titles()).toEqual(['张三'])
    await press('Enter')
    expect($('[data-testid="contacts-section-nav"][data-selected]')?.dataset.sectionKey).toBe('people')
    expect(drawerTitle()).toBe('张三')
  })
})

describe('contacts search (phone home)', () => {
  it('shows results in place of the menu, keeps them across a detail visit, and leaves sub-pages unfiltered', async () => {
    const { onOpenGroupChat } = await render({ mobile: true })
    const menuRow = (label: string) => Array.from(harness.container.querySelectorAll<HTMLElement>('button.gg-row')).find((button) => button.textContent?.startsWith(label))

    // 手机上框收在页头:先点放大镜(ui/HeaderSearch)。
    expect(input()).toBeNull()
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '张')
    expect(browseHidden()).toBe(true)
    expect(rowTitles()).toEqual(['张三'])

    await clickElement(rows()[0])
    expect(detailTitle()).toBe('张三')
    await clickElement($('[aria-label="返回联系人列表"]')!)
    expect(input().value).toBe('张')
    expect(rowTitles()).toEqual(['张三'])

    await typeInto(input(), 'alpha')
    await clickElement(rows()[0])
    expect(onOpenGroupChat).toHaveBeenCalledWith(groups[0])

    await typeInto(input(), '')
    await clickElement(menuRow('个人')!)
    expect(Array.from(harness.container.querySelectorAll('[data-contact-id]')).map((row) => row.getAttribute('data-contact-id')).sort())
      .toEqual(['alan', 'alba', 'ls', 'zs'])
  })

  // 软键盘上的「搜索 / 前往」就是回车。
  it('opens the first hit on Enter from the header box', async () => {
    await render({ mobile: true })
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '张')
    expect(detailTitle()).not.toBe('张三')
    await press('Enter')
    expect(detailTitle()).toBe('张三')
  })

  it('looks a 咕咕号 up on Enter from the header box when it finds nobody', async () => {
    const searchUsers = vi.fn(async () => {})
    await render({ mobile: true, contacts: { searchUsers } })
    await clickElement($('[data-header-search-open]')!)
    await typeInto(input(), '109601')
    expect(rowTitles()).toEqual(['用咕咕号 109601 查找'])
    expect(searchUsers).not.toHaveBeenCalled()
    await press('Enter')
    expect(searchUsers).toHaveBeenCalledWith('109601')
  })
})
