import { EventEmitter } from 'node:events'
import { expect, it, vi, beforeEach } from 'vitest'
const fake = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('@gugu/core/local/childProcess', () => fake)
import { runCursorProcess } from '../../../../external-import/cursor-process'

beforeEach(() => fake.fork.mockReset())
function child() {
  const value = Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    send: vi.fn(), kill: vi.fn(),
  })
  fake.fork.mockReturnValue(value)
  return value
}
it('returns only after the owned child has closed', async () => {
  const process = child()
  const pending = runCursorProcess('/worker.js', { action: 'scan' }, new AbortController().signal)
  process.emit('message', { action: 'scan', result: { rows: [{ sourceId: 'one', title: 'Title' }], failed: 0 } })
  process.emit('close', 0, null)
  expect(await pending).toEqual({ action: 'scan', result: { rows: [{ sourceId: 'one', title: 'Title' }], failed: 0 } })
  expect(fake.fork.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBe('1')
})
it('rejects native child crashes and spawn failures', async () => {
  for (const error of [null, new Error('spawn failed')]) {
    const process = child()
    const pending = runCursorProcess('/worker.js', { action: 'scan' }, new AbortController().signal)
    if (error) process.emit('error', error)
    process.emit('close', null, 'SIGTRAP')
    await expect(pending).rejects.toThrow(error?.message ?? 'SIGTRAP')
  }
})
it('cancellation terminates the exact owned child and rejects its result', async () => {
  const process = child()
  const controller = new AbortController()
  const pending = runCursorProcess('/worker.js', { action: 'scan' }, controller.signal)
  controller.abort(new Error('cancelled'))
  expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  process.emit('close', null, 'SIGKILL')
  await expect(pending).rejects.toThrow('cancelled')
})
