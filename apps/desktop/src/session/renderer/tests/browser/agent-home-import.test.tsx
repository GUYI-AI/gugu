import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { FirstRunImport } from '@/components/firstRun/FirstRunImport'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const calls = vi.hoisted(() => ({ importHome: vi.fn(async () => ({ success: true, data: { issues: [] } })) }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({ importAgentHome: calls.importHome }),
}))
vi.mock('@renderer/lib/components/app-icon', () => ({ AppIcon: () => null }))
const home: AgentHomeScan = {
  providerId: 'claude', name: 'Claude Code', userRoot: '/fixture/.claude', sourceReadable: true,
  importedAt: null, needsImport: true, sourceUpdated: false, migration: false,
  groups: [{ id: 'settings', count: 1 }, { id: 'hooks', count: 2 }, { id: 'mcp', count: 3 }],
  issues: [], mcpSecrets: [], projectMcpCount: 0,
}
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); vi.clearAllMocks() })

it('shows metadata counts, leaves hooks unticked and imports exactly the chosen groups', async () => {
  harness = createReactHarness()
  const done = vi.fn()
  await harness.render(<FirstRunImport homes={[home]} onDone={done} />)
  expect(harness.container.querySelector<HTMLInputElement>('[data-testid="agent-home-group-claude-hooks"]')!.checked).toBe(false)
  expect(harness.container.querySelector('[data-testid="agent-home-card-claude"]')!.textContent).toContain('/fixture/.claude')
  await clickElement(harness.container.querySelector('[data-testid="first-run-import-continue"]')!)
  await expect.poll(() => calls.importHome.mock.calls.length).toBe(1)
  expect(calls.importHome).toHaveBeenCalledWith({ providerId: 'claude', groups: ['settings', 'mcp'] })
  await expect.poll(() => done.mock.calls.length).toBe(1)
})

it('skip still makes an explicit empty import and continues only after it completes', async () => {
  await page.viewport(1280, 900)
  harness = createReactHarness()
  const done = vi.fn()
  await harness.render(<FirstRunImport homes={[home]} onDone={done} />)
  await clickElement(harness.container.querySelector('[data-testid="first-run-import-skip"]')!)
  await expect.poll(() => done.mock.calls.length).toBe(1)
  expect(calls.importHome).toHaveBeenCalledWith({ providerId: 'claude', groups: [] })
})
