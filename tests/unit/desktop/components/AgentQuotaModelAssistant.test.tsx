// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

const stored = vi.hoisted(() => ({ dismiss: vi.fn(), failure: null as null | Record<string, unknown> }))
const entry = vi.hoisted(() => ({ openAssistantPageInApp: vi.fn(() => true) }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: vi.fn(), dismissNotice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure', () => ({ useStoredAgentTurnFailure: () => stored }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({
  useContactsStore: () => ({ contacts: [{ id: 'assistant', type: 'agent', display_name: '咕咕' }, { id: 'other', type: 'agent', display_name: 'Codex' }] }),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ requeueErroredDeviceCommand: vi.fn(), getCurrentAuthUserId: async () => null, chatDb: {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {} }))
vi.mock('@/lib/avatarIdentity', async (original) => ({ ...await original<object>(), useIsAssistantAvatar: (id: string) => id === 'assistant' }))
vi.mock('@/lib/assistantEntry', () => entry)
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({
  AgentSettingsModal: ({ initialTab }: { initialTab?: string }) => <div data-testid="agent-settings-modal" data-tab={initialTab} />,
}))

import { AgentTurnFailureSlot } from '../../../../apps/desktop/src/components/AgentTurnFailureBar'

let ui: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { ui?.cleanup(); stored.failure = null; entry.openAssistantPageInApp.mockClear() })

async function openModelFor(agentUserId: string) {
  stored.failure = { agentUserId, commandId: 'cmd', reason: 'modelUnavailable', at: 1, revision: 'r1' }
  ui = createReactHarness()
  await ui.render(createNode(AgentTurnFailureSlot, { chatId: 'chat', threadRootId: null, profiles: { [agentUserId]: { displayName: agentUserId } } }))
  const status = ui.container.querySelector('[data-testid="agent-quota-status"]')!
  await clickElement(status.querySelector<HTMLButtonElement>('button:not([data-testid="agent-quota-dismiss"])')!)
}

// The personal assistant's dialog is its figure alone (owner 11-12): 换模型 goes to its App's settings page, at the model.
it('the assistant: 换模型 opens its App settings page at the model, no agent dialog', async () => {
  await openModelFor('assistant')
  expect(entry.openAssistantPageInApp).toHaveBeenCalledExactlyOnceWith('settings', 'aimodel')
  expect(ui!.container.querySelector('[data-testid="agent-settings-modal"]')).toBeNull()
})

it('[positive control] another agent: 换模型 opens its agent dialog at AI 模型', async () => {
  await openModelFor('other')
  expect(entry.openAssistantPageInApp).not.toHaveBeenCalled()
  expect(ui!.container.querySelector('[data-testid="agent-settings-modal"]')?.getAttribute('data-tab')).toBe('aimodel')
})
