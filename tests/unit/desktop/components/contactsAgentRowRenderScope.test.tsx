// @vitest-environment jsdom
// 通讯录 agent 节点(分组页的导图,AgentMindMap @@@map-node-memo)的重渲染范围:一个 agent 变了只重画那一个节点;
// 设备表心跳不重画任何一个。从前改一个名字整列每行都重画(100 个 agent = 每次 100 行),n 个 agent 各推一次就是 O(n²)。
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import { clickElement, contact, createNode, createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'

// 每个导图节点每次渲染都按自己的名字问一次显示名(useShownAgentName):按名字数这一问,就是数节点渲染了几次。
const rowRenders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../../apps/desktop/src/hooks/useShownAgentName', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/hooks/useShownAgentName')>()
  return {
    ...original,
    useShownAgentName: ((input: { name: string } | readonly { name: string }[]) => {
      const name = Array.isArray(input) ? null : (input as { name: string }).name
      if (name && /^(Agent |Renamed )/.test(name)) rowRenders.set(name, (rowRenders.get(name) ?? 0) + 1)
      return original.useShownAgentName(input as never)
    }) as unknown as typeof original.useShownAgentName,
  }
})
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); rowRenders.clear() })
afterEach(() => { harness.cleanup() })

const devicesStore = (devices: Device[]): DevicesContextValue => ({
  devices, loading: false, error: null, refresh: vi.fn(), rename: vi.fn(), remove: vi.fn(), listBoundAgents: vi.fn(),
})
const agents = ['a', 'b', 'c'].map((id) => contact({ id, type: 'agent', display_name: `Agent ${id}`, owner_user_id: 'owner-1', device_id: 'laptop' }))

// 像用户一样在左栏点开这台设备的分组:右边铺开它的导图。
async function openDeviceSection() {
  const navs = [...harness.container.querySelectorAll<HTMLElement>('[data-testid="contacts-section-nav"]')]
  await clickElement(navs.find((nav) => !['unknown', 'people', 'groups'].includes(nav.dataset.sectionKey!))!)
}

async function render(contacts: ContactUser[], devices: Device[]) {
  await renderWithAppProviders(harness, createElement(DevicesContext.Provider, { value: devicesStore(devices) }, createNode(ContactsPanel, {})), {
    shellTab: 'contacts',
    auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
    contacts: { contacts },
    chat: { chats: [] },
  })
}

describe('contacts agent rows re-render only for their own change', () => {
  it('renaming one agent re-renders that row only', async () => {
    const devices = [device('laptop', [], { is_online: true })]
    await render(agents, devices)
    await openDeviceSection()
    expect([...rowRenders.keys()].sort()).toEqual(['Agent a', 'Agent b', 'Agent c'])
    rowRenders.clear()

    await render([agents[0]!, { ...agents[1]!, display_name: 'Renamed b' }, agents[2]!], devices)
    expect(harness.container.querySelector('[data-contact-id="b"]')?.textContent).toContain('Renamed b')
    expect(Object.fromEntries(rowRenders)).toEqual({ 'Renamed b': 1 })
  })

  it('a device heartbeat (new device list, same facts) re-renders no row', async () => {
    await render(agents, [device('laptop', [], { is_online: true, last_seen_at: '2026-11-05T00:00:00.000Z' })])
    await openDeviceSection()
    expect(rowRenders.size).toBe(3)
    rowRenders.clear()
    await render(agents, [device('laptop', [], { is_online: true, last_seen_at: '2026-11-05T00:00:30.000Z' })])
    expect(Object.fromEntries(rowRenders)).toEqual({})
  })
})
