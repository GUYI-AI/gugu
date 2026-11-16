// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * The built-in server's tool-group switch is drawn on the click. Refused, the host's copy is read again; when that read
 * fails too, the switch goes back to what was read before the click (I4) — ❌ left on a value the host never took.
 */
const library = vi.hoisted(() => ({
  provided: vi.fn(),
  setGuguToolsOff: vi.fn(),
  list: vi.fn(async () => []),
}))
const host = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  useLibraryHost: () => host.value, keepLibraryHost: (h: unknown) => h, libraryHostOf: () => host.value,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/use-agents', () => ({ useManagementAgents: () => ({ data: [], isLoading: false, error: null }) }))

const { useMcpLibrary } = await import('../../../../apps/desktop/src/session/renderer/features/mcp/components/use-mcp-library')

let h: ReturnType<typeof createReactHarness>
let run = 0
beforeEach(() => {
  h = createReactHarness()
  run += 1
  host.value = { key: `mcp-host-${run}`, remote: undefined, mcpLibrary: library }
  library.provided.mockReset().mockResolvedValue({ builtIn: ['gugu'], servers: [], guguToolsOff: [] })
  library.setGuguToolsOff.mockReset()
})
afterEach(() => h.cleanup())

let api: ReturnType<typeof useMcpLibrary>
function Probe() { api = useMcpLibrary(); return null }

it('refused, and the read again fails too: back to the groups read before the click', async () => {
  await h.render(<Probe />)
  await vi.waitFor(() => expect(api.provided?.guguToolsOff).toEqual([]))
  library.setGuguToolsOff.mockRejectedValue(new Error('refused'))
  library.provided.mockRejectedValue(new Error('host gone'))
  await act(async () => { await expect(api.setGuguToolsOff(['files'] as never)).rejects.toThrow('refused') })
  expect(api.provided?.guguToolsOff).toEqual([])
})

it('refused, and the read again lands: what the host says now', async () => {
  await h.render(<Probe />)
  await vi.waitFor(() => expect(api.provided?.guguToolsOff).toEqual([]))
  library.setGuguToolsOff.mockRejectedValue(new Error('refused'))
  library.provided.mockResolvedValue({ builtIn: ['gugu'], servers: [], guguToolsOff: ['web'] })
  await act(async () => { await expect(api.setGuguToolsOff(['files'] as never)).rejects.toThrow('refused') })
  expect(api.provided?.guguToolsOff).toEqual(['web'])
})
