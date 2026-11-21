// @vitest-environment jsdom
// This desktop's SSH machine list (main answers it): a failed read is not kept for ever — until it is read, every SSH
// machine is drawn by its cloud heartbeat, which its rows must not be. Read again when the window comes back.
import { beforeEach, expect, it, vi } from 'vitest'
import { focusManager, notifyManager, QueryObserver } from '@tanstack/react-query'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke, eventOn: () => () => undefined }) }))

const { sshMachineAddresses } = await import('../../../../apps/desktop/src/lib/sshMachineAddresses')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  queryClient.clear()
  followRendererSession('SIGNED_IN', 'me')
  invoke.mockReset()
})

it('a failed read is read again when the window comes back', async () => {
  invoke.mockRejectedValue(new Error('main busy'))
  // A surface shows it: its read fails.
  const shown = new QueryObserver(queryClient, sshMachineAddresses.options(sshMachineAddresses.key()!) as never)
  const stop = shown.subscribe(() => undefined)
  await vi.waitFor(() => expect(sshMachineAddresses.peek().state).toBe('error'))
  invoke.mockResolvedValue([{ deviceId: 'ssh-1', display: 'me@host' }])
  // The window comes back.
  focusManager.setFocused(false)
  focusManager.setFocused(true)
  await vi.waitFor(() => expect(sshMachineAddresses.peek().state).toBe('value'))
  stop()
})
