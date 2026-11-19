// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * The 「端口」 tab of a session on an SSH machine: the forwards and listening ports read before, a refresh (the header's
 * button) that fails is said with a retry, the rows read before staying — ❌ shown as current.
 */
const host = vi.hoisted(() => ({ fail: false }))
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useWorkspaceSurface: () => ({ unreachableLabel: null }),
  useWorkspaceViewModel: () => ({ showPage: vi.fn() }),
}))
vi.mock('@renderer/lib/machine-routing', async (importOriginal) => {
  const original = await importOriginal<{ machineRegistry: object }>()
  return { ...original, machineRegistry: Object.assign(Object.create(original.machineRegistry), { machineOf: () => 'ports-dev' }) }
})
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => ({ label: 'box' }) } }))
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { remotePorts: { list: async () => (host.fail ? { success: false, error: { type: 'unreachable' } }
    : { success: true, data: { forwards: [{ remotePort: 5173, localPort: 15173, phase: 'ready', holders: ['manual'] }], detected: [] } }) } },
  rpcOn: () => ({ machine: { listeningPorts: async () => (host.fail ? { success: false, error: { message: 'machine unreachable' } }
    : { success: true, data: { supported: true, ports: [{ port: 5173, process: 'vite' }] } }) } }),
}))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipContent: () => null,
}))

const { followRendererSession } = await import('../../../../apps/desktop/src/lib/replica')
const { TabContent } = await import('../../../../apps/desktop/src/session/renderer/features/remote-hosts/workspace/remote-ports-tab-view')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { followRendererSession('SIGNED_IN', 'ports-owner'); h = createReactHarness(); host.fail = false })
afterEach(() => h.cleanup())

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const refreshButton = () => h.container.querySelector<HTMLButtonElement>('button[aria-label="remotePorts.refresh"]')!
const text = () => h.container.textContent ?? ''

it('a refresh that fails over the rows read before says so, the rows staying', async () => {
  await h.render(<TabContent host={{ resolvedTabs: [{ kind: 'remote-ports', isActive: true }] } as never}
    ctx={{ viewId: 'view-1', projectId: 'remote:ports-dev', sessionId: 'session-1' } as never} />)
  await settle()
  expect(text()).toContain('5173')
  expect(text()).toContain('vite')
  expect(text()).not.toContain('machine unreachable')
  host.fail = true
  await act(async () => { refreshButton().click() })
  await settle()
  expect(text()).toContain('machine unreachable')
  expect(text()).toContain('remote ports of ports-dev not listed')
  expect(text()).toContain('vite')
})
