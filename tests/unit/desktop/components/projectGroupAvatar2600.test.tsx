// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneProjectChatAvatar } from '../../../../apps/desktop/src/mobile/partners/PhoneProjectChatAvatar'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
// `project-chat` is the group of a project on this machine: the row is a project group row.
vi.mock('../../../../apps/desktop/src/store/devicesContext', async () => {
  const { device: makeDevice } = await import('../../../support/testHarness')
  return { useDevicesStore: () => ({ devices: [makeDevice('host', [], {
    projects: [{ localProjectId: 'project', chatId: 'project-chat', name: 'task-project', rootPath: '/project', createdAt: '2026-11-02T00:00:00Z', folders: [] }],
  })] }) }
})

describe('#2600 a project group row keeps the group avatar', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => harness.cleanup())

  it.each([false, true])('mobile=%s: the group avatar is drawn, no folder cover in its place', async (mobile) => {
    await renderWithAppProviders(harness, createNode(PhoneProjectChatAvatar, {
      chat: chat({ id: 'project-chat', kind: 'group', name: 'task-project' }),
      mobile,
      children: <span data-avatar="group">group avatar</span>,
    }), { chat: {}, contacts: {} })
    expect(harness.container.querySelector('[data-avatar="group"]')).not.toBeNull()
    expect(harness.container.querySelector('svg.gg-project-avatar')).toBeNull()
  })
})
