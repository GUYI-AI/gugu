// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, waitForCondition } from '../../../support/testHarness'

/**
 * 资源库 → MCP on this machine: a read that fails over what is still drawn (咕咕's own list, 咕咕提供, an agent's own servers,
 * the installed agents) is said with a retry in its section, the rows read before staying — ❌ shown as current.
 */
const library = vi.hoisted(() => ({
  fail: false,
  list: vi.fn(),
  provided: vi.fn(),
  harnessServers: vi.fn(),
  // The built-in row checks its tools on open; that check is not this test's.
  providedTools: vi.fn(() => new Promise(() => undefined)),
}))
const agents = vi.hoisted(() => ({ reading: null as unknown, refetch: vi.fn() }))
const host = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  useLibraryHost: () => host.value, keepLibraryHost: (h: unknown) => h, libraryHostOf: () => host.value,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/use-agents', () => ({ useManagementAgents: () => agents, useAgentIcon: () => null }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => undefined }))

const { McpLibraryView } = await import('../../../../apps/desktop/src/session/renderer/features/mcp/components/McpLibraryView')
const { harnessMcpServers, mcpLibraryServers, mcpProvided } = await import('../../../../apps/desktop/src/session/renderer/features/mcp/components/use-mcp-library')

const failing = <T,>(value: T) => async () => { if (library.fail) throw new Error('host unreachable'); return value }
let h: ReturnType<typeof createReactHarness>
let run = 0
beforeEach(() => {
  h = createReactHarness()
  run += 1
  library.fail = false
  host.value = { key: `mcp-refresh-${run}`, remote: null, mcpLibrary: library }
  library.list.mockReset().mockImplementation(failing([{ name: 'notes', command: 'node', args: [], enabledByDefault: true }]))
  library.provided.mockReset().mockImplementation(failing({ builtIn: ['gugu'], servers: [], guguToolsOff: [] }))
  library.harnessServers.mockReset().mockImplementation(failing([{ server: { name: 'fs', command: 'npx', args: [] } }]))
  agents.reading = { state: 'value', value: [{ id: 'claude', name: 'Claude', reading: 'ready' }], stale: false, error: null }
})
afterEach(() => h.cleanup())

const failures = () => h.container.querySelectorAll('[data-refresh-failed]').length
const text = () => h.container.textContent ?? ''

it('this machine: each section says its own failed refresh with a retry, its rows staying', async () => {
  const key = (host.value as { key: string }).key
  await h.render(<McpLibraryView onOpenIntegrations={() => undefined} />)
  await waitForCondition(() => text().includes('notes'), 'own list not drawn')
  const harness = h.container.querySelector('[data-slot="mcp-library-harness"] button') as HTMLButtonElement
  await act(async () => { harness.click() })
  await waitForCondition(() => text().includes('fs'), 'agent servers not drawn')
  expect(failures()).toBe(0)

  library.fail = true
  await act(async () => {
    await Promise.all([mcpLibraryServers.refresh(key), mcpProvided.refresh(key), harnessMcpServers.refresh(key, 'claude')].map((read) => read.catch(() => undefined)))
  })
  agents.reading = { state: 'value', value: [{ id: 'claude', name: 'Claude', reading: 'ready' }], stale: false, error: new Error('host unreachable') }
  await h.render(<McpLibraryView onOpenIntegrations={() => undefined} />)
  await waitForCondition(() => failures() === 4, `failed refreshes not said (${failures()})`)
  expect(text()).toContain('notes')
  expect(text()).toContain('fs')

  library.fail = false
  await act(async () => { (h.container.querySelector('[data-refresh-failed] button') as HTMLButtonElement).click() })
  expect(agents.refetch).toHaveBeenCalled()
})
