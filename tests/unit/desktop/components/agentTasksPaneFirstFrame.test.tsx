// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

/** An agent's scheduled tasks before they are read: the heading's count is a placeholder, never「（0）」. */
vi.mock('../../../../apps/desktop/src/lib/agentScheduledTasks', () => ({
  agentScheduledTaskService: { list: () => new Promise(() => {}), create: vi.fn(), setEnabled: vi.fn(), remove: vi.fn() },
}))
const { AgentTasksPane } = await import('../../../../apps/desktop/src/components/agentsettings/AgentTasksPane')

const agent = { id: 'agent-1', type: 'agent', display_name: 'Codex 1' } as unknown as ContactUser

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('agent scheduled tasks, first frame', () => {
  it('draws the count as a placeholder until the tasks are read', async () => {
    await renderWithAppProviders(harness, createNode(AgentTasksPane, { agent }))
    const heading = harness.container.querySelector('[data-pane="tasks"]')!
    expect(heading.textContent).not.toMatch(/[（(]0[）)]/)
    expect(heading.querySelector('[data-unknown]')).not.toBeNull()
  })
})
