// @vitest-environment jsdom
// F2-4: the machine answered once which background commands run, then cannot be asked: its old answer is not what runs
// now — every candidate is listed and no stop key is offered (❌ filtered by stale ids, stop keys on them).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rpc = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', async (original) => ({ ...await original<object>(), fetchBackgroundTasks: rpc.fetch }))
vi.mock('@gugu/session-chat-ui/background-rosters', async (original) => ({
  ...await original<object>(),
  collectBackgroundCommandRoster: (_c: unknown, _a: unknown, _l: unknown, ids: readonly string[] | null) =>
    [{ taskId: 'cmd-1', id: 'cmd-1' }, { taskId: 'cmd-2', id: 'cmd-2' }].filter((row) => ids === null || ids.includes(row.taskId)),
  collectSubagentRoster: () => [],
}))

const { usePhoneBackgroundTasks, sessionBackgroundTasks } = await import('../../../apps/desktop/src/mobile/agent-watch/background-tasks')
const { followRendererSession, queryClient } = await import('../../../apps/desktop/src/lib/replica')

it('lists every candidate without a stop key once its machine cannot be asked again', async () => {
  queryClient.clear()
  followRendererSession('SIGNED_IN', 'owner')
  rpc.fetch.mockResolvedValueOnce({ runningCommandTaskIds: ['cmd-1'] }).mockRejectedValue(new Error('machine away'))
  let latest: ReturnType<typeof usePhoneBackgroundTasks> | null = null
  function Probe() { latest = usePhoneBackgroundTasks('dev', 'session', [], 0, true, []); return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await vi.waitFor(() => expect(latest!.canStop).toBe(true))
  expect(latest!.commands.map((row) => row.taskId)).toEqual(['cmd-1'])
  await act(async () => { await sessionBackgroundTasks.refresh('dev', 'session', false) })
  await vi.waitFor(() => expect(latest!.canStop).toBe(false))
  expect(latest!.commands.map((row) => row.taskId)).toEqual(['cmd-1', 'cmd-2'])
  await act(async () => root.unmount())
})
