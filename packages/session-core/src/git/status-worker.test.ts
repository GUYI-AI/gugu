import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createGitStatusClient, type GitStatusWorkerRequest } from './status-worker'

class FakeWorker extends EventEmitter {
  postMessage = vi.fn((message: GitStatusWorkerRequest) => {
    if (message.type === 'dispose') queueMicrotask(() => this.emit('exit', 0))
  })
  terminate = vi.fn(async () => 0)
}
const request = { worktree: '/repository', file: 'git' }
const status = { kind: 'too-many-files' } as const

describe('Git status worker client', () => {
  it('routes out-of-order replies to their matching readers', async () => {
    const worker = new FakeWorker()
    const client = createGitStatusClient(() => worker)
    const first = client.read(request)
    const second = client.read(request)
    worker.emit('message', { id: 2, result: status })
    worker.emit('message', { id: 1, result: { kind: 'error', message: 'actual git error' } })
    await expect(second).resolves.toEqual(status)
    await expect(first).resolves.toEqual({ kind: 'error', message: 'actual git error' })
    await client.dispose()
  })

  it('rejects pending reads if the worker exits, and starts a new worker on a later request', async () => {
    const workers: FakeWorker[] = []
    const spawn = vi.fn(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })
    const client = createGitStatusClient(spawn)
    const failed = expect(client.read(request)).rejects.toThrow('exited (code 1)')
    workers[0].emit('exit', 1)
    await failed
    const retry = client.read(request)
    workers[0].emit('message', { id: 2, result: { kind: 'error', message: 'stale worker' } })
    workers[1].emit('message', { id: 2, result: status })
    await expect(retry).resolves.toEqual(status)
    expect(spawn).toHaveBeenCalledTimes(2)
    await client.dispose()
  })

  it('reports worker errors instead of substituting an empty status', async () => {
    const worker = new FakeWorker()
    const client = createGitStatusClient(() => worker)
    const failed = expect(client.read(request)).rejects.toThrow('worker failed')
    worker.emit('error', new Error('worker failed'))
    await failed
    worker.emit('exit', 1)
    await client.dispose()
  })

  it('cancels pending reads and waits for graceful shutdown on disposal', async () => {
    const worker = new FakeWorker()
    const client = createGitStatusClient(() => worker)
    const pending = expect(client.read(request)).rejects.toThrow('disposed')
    await client.dispose()
    await pending
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'dispose' })
    expect(worker.terminate).not.toHaveBeenCalled()
    await expect(client.read(request)).rejects.toThrow('disposed')
  })
  it('joins concurrent disposal calls until the worker has exited', async () => {
    const worker = new FakeWorker()
    worker.postMessage.mockImplementation(() => {})
    const client = createGitStatusClient(() => worker)
    const pending = expect(client.read(request)).rejects.toThrow('disposed')
    const first = client.dispose()
    const second = client.dispose()
    expect(second).toBe(first)
    worker.emit('exit', 0)
    await Promise.all([first, second, pending])
  })
})
