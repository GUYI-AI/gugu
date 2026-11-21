// @vitest-environment jsdom
// 通讯录群组页:群行说里面有谁(人 / Agent)、绑的哪个项目文件夹、最近一次动静与未读,按动静排;
// 点开的抽屉就是群资料(群号、项目文件夹、成员按人 / Agent 分开),❌ 大头像、❌「群类型」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ChatItem, Device } from '@gugu/core/shared/types/chat'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { DevicesContext } from '../../../../apps/desktop/src/store/devicesContext'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const identity = (id: string, type: 'human' | 'agent', display_name: string) => ({ id, type, display_name, avatar: null, owner_user_id: type === 'agent' ? 'someone' : null, device_id: null, created_at: null }) as unknown as DisplayIdentity
const identities = [identity('owner-1', 'human', 'Owner'), identity('alice', 'human', 'Alice'), identity('coder', 'agent', 'Coder'), identity('review', 'agent', 'Review')]
const chat = (id: string, name: string, members: string[], lastMessageAt: string | null, unread = 0) => ({
  id, name, kind: 'group', status: 'active', member_user_ids: members, created_at: '2026-11-01T00:00:00Z', last_message_at: lastMessageAt,
  last_message_preview: null, unread_count: unread, is_pinned: false, is_muted: false,
}) as unknown as ChatItem
const chats = [
  chat('old', 'Old group', ['owner-1', 'alice'], '2026-11-10T00:00:00Z'),
  chat('project', 'Desk', ['owner-1', 'coder', 'review'], '2026-11-21T09:00:00Z', 3),
  chat('quiet', 'Quiet', ['owner-1'], null),
]
const device = {
  device_id: 'mini', label: 'mac-mini', is_current_device: false, is_online: true,
  projects: [{ localProjectId: 'p1', name: 'gugu', rootPath: '~/work/gugu', createdAt: '2026-11-01T00:00:00Z', chatId: 'project', folders: [] }],
} as unknown as Device

async function render() {
  const node = createElement(DevicesContext.Provider, { value: { devices: [device], loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] } }, createNode(ContactsPanel, {}))
  await renderWithAppProviders(harness, node, { shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts: [], groupChats: chats.map((c) => ({ id: c.id, kind: 'group' as const, name: c.name, avatar_url: null, member_count: c.member_user_ids!.length, is_muted: false, member_user_ids: c.member_user_ids })) },
    chat: { chats, identitiesById: Object.fromEntries(identities.map((i) => [i.id, i])) },
  })
  await clickElement(harness.container.querySelector('[data-testid="contacts-section-nav"][data-section-key="groups"]') as HTMLElement)
}
const row = (id: string) => harness.container.querySelector(`[data-testid="contacts-section-pane"] [data-group-id="${id}"]`) as HTMLElement

describe('contacts Groups page', () => {
  it('rows say who is inside, which folder, the last activity and unread; newest activity first', async () => {
    await render()
    const ids = [...harness.container.querySelectorAll<HTMLElement>('[data-testid="contacts-section-pane"] [data-group-id]')].map((r) => r.dataset.groupId)
    expect(ids).toEqual(['project', 'old', 'quiet'])
    expect(row('project').textContent).toContain('gugu')
    expect(row('project').textContent).toContain('1 人 · 2 Agent')
    expect(row('project').querySelector('[data-slot="chip"][data-shape="count"]')?.textContent).toBe('3')
    expect(row('project').hasAttribute('data-emphasis')).toBe(true)
    expect(row('old').textContent).toContain('2 人')
    expect(row('old').textContent).not.toContain('Agent')
    expect(row('old').textContent).not.toContain('名成员')
  })

  it('the drawer is the group profile: number, project folder, no invented group type', async () => {
    await render()
    await clickElement(row('project'))
    const drawer = harness.container.querySelector('[data-testid="contacts-detail-drawer"]') as HTMLElement
    expect(drawer.textContent).toContain('项目群 · 3 位成员')
    expect(drawer.textContent).toContain('项目文件夹')
    expect(drawer.textContent).toContain('mac-mini · ~/work/gugu')
    expect(drawer.textContent).not.toContain('群类型')
    expect(drawer.textContent).toContain('进入群聊')
  })
})
