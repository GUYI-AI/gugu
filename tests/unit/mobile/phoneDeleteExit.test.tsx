// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneMemory } from '../../../apps/desktop/src/mobile/assistant/PhoneMemory'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import { expectExit, frame, holdDialogExit } from '../../support/dialogExit'

const m = vi.hoisted(() => ({ data: {} as Record<string, unknown>, remove: vi.fn(async () => undefined), reload: vi.fn() }))
// The memory cards are derived from the panel snapshot (replica `assistantPanel`): here, read.
vi.mock('../../../apps/desktop/src/components/assistant/assistant-panel-reads', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/components/assistant/assistant-panel-reads')>(),
  useAssistantPanelCollection: (_machine: unknown, domain: string) => ({ state: 'value', value: m.data[domain] ?? null, stale: false, error: null }),
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneRoutines', () => ({ usePhoneRoutines: () => ({
  routines: [{ id: 'routine-1', name: 'Routine', enabled: false, triggerConfig: { expr: '0 9 * * *' }, agentConfig: {} }],
  read: { state: 'ok', data: [], reload: m.reload },
  // Not a shared computer home: no session directory is part of the ownership read.
  directory: null,api: { remove: m.remove },
}) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneMemoryData', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/assistant/phoneMemoryData')>(), deleteMemoryNote: m.remove,
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData')>(), deleteVoiceNote: m.remove,
}))
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core')>(), removePath: m.remove,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ automations: { deleteAutomation: m.remove } }) }))
vi.mock('../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: () => null }))

let h: ReturnType<typeof createReactHarness>
let exit: ReturnType<typeof holdDialogExit>
beforeEach(() => {
  h = createReactHarness(); exit = holdDialogExit(); vi.clearAllMocks()
  m.data = {
    memory: { notes: [{ file: 'note.md', title: 'Memory', body: 'Remember', kind: 'user', path: '/memory/note.md' }] },
  }
})
afterEach(() => { h.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })

const machine = { deviceId: 'device-1', projectId: 'project-1', workspaceId: 'workspace-1', home: '/home/test', paths: { memoryDir: '/memory' } }
const cases = [
  { label: 'memory', component: PhoneMemory, props: { sub: 'note:note.md' }, open: 'assistant-memory-delete', dialog: 'assistant-memory-delete-dialog' },
]
for (const c of cases) it(`${c.label}: the actual page stays mounted until confirmation exit, then navigates`, async () => {
  const go = vi.fn()
  await renderWithAppProviders(h, createNode(c.component, {
    assistant: { id: 'agent-1', display_name: 'Assistant' }, homeDeviceId: 'device-1', readiness: 'ready', machine: { state: 'ready', machine }, go, askInChat: vi.fn(), ...c.props,
  }), { toast: vi.fn() })
  await clickElement(document.querySelector(`[data-testid="${c.open}"]`)!); await frame()
  const popup = document.querySelector<HTMLElement>(`[data-testid="${c.dialog}"]`)!
  await clickElement(document.querySelector(`[data-testid="${c.dialog}-confirm"]`)!)
  expect(m.remove).toHaveBeenCalledOnce()
  expect(go).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(go).toHaveBeenCalledOnce()
})
