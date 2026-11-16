// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * Independent review item 6: the project folder cards are push-fed (`fresh: Infinity`). Folders read earlier in the run
 * changed while nobody listened (the home page was left): opening it again reads them again (❌ the old task count and
 * branch until the next push); one machine subscription however many cards show its folders.
 */
const machine = vi.hoisted(() => ({ listeners: new Map<string, Set<(payload: unknown) => void>>(), version: 1 }))
const list = vi.hoisted(() => vi.fn(async (projectId: string) => ({ success: true, data: [{ projectId, path: `/work-${machine.version}` }] })))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { projects: { listProjectFolders: list } },
  onMachineEvent: (_machine: string | null, channel: { name?: string } | string, listener: (payload: unknown) => void) => {
    const id = typeof channel === 'string' ? channel : JSON.stringify(channel)
    const set = machine.listeners.get(id) ?? new Set()
    set.add(listener); machine.listeners.set(id, set)
    return () => { set.delete(listener) }
  },
}))
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { connectionState: () => 'connected', accountFolders: () => null, accountUnread: () => false, accountIsNewer: () => false },
}))
vi.mock('@/components/assistant/assistant-app-client', () => ({ reportAssistantAppChange: vi.fn() }))

const { followRendererSession } = await import('@/lib/replica')
const { projectFolders, useProjectFolders } = await import('@renderer/features/projects/components/main-panel/project-folders')

const listening = () => [...machine.listeners.values()].reduce((sum, set) => sum + set.size, 0)
let shown: string[] = []
function Home() {
  const state = useProjectFolders('p1')
  shown = (state.folders ?? []).map((folder) => folder.path)
  return null
}

beforeEach(() => { followRendererSession('SIGNED_IN', 'owner-a'); machine.version = 1; list.mockClear() })
afterEach(() => { followRendererSession('SIGNED_OUT', null) })

it('folders read before reopening the home page are read again when it opens, and the machine is listened to only while shown', async () => {
  const first = createReactHarness()
  await first.render(createElement(Home))
  await act(async () => { await vi.waitFor(() => expect(projectFolders.peek('p1').state).toBe('value')) })
  expect(listening()).toBeGreaterThan(0)
  first.cleanup({ keepReads: true })
  expect(listening()).toBe(0)

  // Changed on the machine while nobody listened.
  machine.version = 2
  list.mockClear()
  const again = createReactHarness()
  await again.render(createElement(Home))
  // The kept folders draw at once (no reordering, no blank) and the read lands in place.
  await act(async () => { await vi.waitFor(() => expect(shown).toEqual(['/work-2'])) })
  expect(list).toHaveBeenCalledTimes(1)
  again.cleanup({ keepReads: true })
})
