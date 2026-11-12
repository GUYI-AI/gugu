// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneProjectChatAvatar } from '../../../../apps/desktop/src/mobile/partners/PhoneProjectChatAvatar'
import { publishMyChatAgentCounts } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

describe('running count on a desktop project row', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => {
    act(() => publishMyChatAgentCounts(new Map()))
    harness.cleanup()
  })
  const render = (chatId: string) => renderWithAppProviders(harness, createNode(PhoneProjectChatAvatar, {
    chat: chat({ id: chatId, kind: 'group' }),
    mobile: false,
    children: <span data-avatar="">avatar</span>,
  }), { chat: {}, contacts: {} })
  const badge = () => harness.container.querySelector<HTMLElement>('[data-project-running]')

  it('shows how many of my agents run in the project, and follows the published count', async () => {
    publishMyChatAgentCounts(new Map([['project-chat', { total: 5, running: 2 }]]))
    await render('project-chat')
    expect(harness.container.querySelector('[data-avatar]')).not.toBeNull()
    expect(badge()?.dataset.projectRunning).toBe('2')
    expect(badge()?.textContent).toContain('2')
    await act(async () => publishMyChatAgentCounts(new Map([['project-chat', { total: 5, running: 0 }]])))
    expect(badge()).toBeNull()
  })

  it('an ordinary group carries no count (nothing is published for it), nor does anything with the switch off', async () => {
    publishMyChatAgentCounts(new Map([['project-chat', { total: 1, running: 1 }]]))
    await render('ordinary-group')
    expect(harness.container.querySelector('[data-avatar]')).not.toBeNull()
    expect(badge()).toBeNull()
  })
})
