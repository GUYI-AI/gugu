// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const eventOn = vi.fn()
const events = new Map<string, (data?: unknown) => void>()
beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  invoke.mockReset()
  eventOn.mockReset()
  events.clear()
  eventOn.mockImplementation((channel, listener) => { events.set(channel, listener); return () => events.delete(channel) })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke, eventOn } })
})

it('retains a drained cold callback during a login remount and receives hot callbacks through the same source', async () => {
  let deliver!: (urls: string[]) => void
  invoke.mockImplementation((channel) => {
    if (channel === 'auth:oauth-redirect') return Promise.resolve('gugu-dev://auth/callback')
    return new Promise<string[]>((resolve) => { deliver = resolve })
  })
  const { electronAuthCallbacks } = await import('../../../../apps/desktop/src/platform/electronOpenedLinks')
  const first = vi.fn(), onError = vi.fn()
  const stop = electronAuthCallbacks.subscribe(first, onError)
  const ready = electronAuthCallbacks.ready()
  stop()
  deliver(['gugu-dev://auth/callback?code=cold'])
  await ready
  expect(first).not.toHaveBeenCalled()
  const remounted = vi.fn()
  const stopNext = electronAuthCallbacks.subscribe(remounted, onError)
  expect(remounted).toHaveBeenCalledExactlyOnceWith('gugu-dev://auth/callback?code=cold')
  events.get('opened-links:available')!()
  deliver(['gugu-dev://auth/callback?code=hot'])
  await vi.waitFor(() => expect(remounted).toHaveBeenCalledTimes(2))
  expect(eventOn).toHaveBeenCalledOnce()
  await expect(electronAuthCallbacks.redirectTo()).resolves.toBe('gugu-dev://auth/callback')
  expect(onError).not.toHaveBeenCalled()
  stopNext()
})

it('reports initial IPC failure and allows explicit readiness retry without adding another source', async () => {
  const failure = new Error('main window not ready')
  invoke.mockRejectedValueOnce(failure).mockResolvedValue([])
  const { electronAuthCallbacks } = await import('../../../../apps/desktop/src/platform/electronOpenedLinks')
  const onError = vi.fn()
  const stop = electronAuthCallbacks.subscribe(vi.fn(), onError)
  await expect(electronAuthCallbacks.ready()).rejects.toBe(failure)
  await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure))
  await expect(electronAuthCallbacks.ready()).resolves.toBeUndefined()
  expect(eventOn).toHaveBeenCalledOnce()
  stop()
})

it('surfaces malformed callback delivery instead of treating it as an empty inbox', async () => {
  invoke.mockResolvedValue(['gugu-dev://auth/callback?code=valid', 5])
  const { electronAuthCallbacks } = await import('../../../../apps/desktop/src/platform/electronOpenedLinks')
  const listener = vi.fn(), onError = vi.fn()
  const stop = electronAuthCallbacks.subscribe(listener, onError)
  await expect(electronAuthCallbacks.ready()).rejects.toThrow('Invalid opened-link delivery')
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
  expect(listener).not.toHaveBeenCalled()
  stop()
})

it('hands every OS-opened link to watchers and gives login only the OAuth callbacks', async () => {
  invoke.mockResolvedValue(['gugu-dev://gugu.nextmind.space/j/?114181', 'gugu-dev://auth/callback?code=c'])
  const { electronAuthCallbacks, watchElectronOpenedLinks } = await import('../../../../apps/desktop/src/platform/electronOpenedLinks')
  const listener = vi.fn(), watcher = vi.fn(), onError = vi.fn()
  const stopWatch = watchElectronOpenedLinks(watcher, onError)
  const stop = electronAuthCallbacks.subscribe(listener, onError)
  await electronAuthCallbacks.ready()
  expect(watcher.mock.calls).toEqual([['gugu-dev://gugu.nextmind.space/j/?114181'], ['gugu-dev://auth/callback?code=c']])
  expect(listener).toHaveBeenCalledExactlyOnceWith('gugu-dev://auth/callback?code=c')
  expect(onError).not.toHaveBeenCalled()
  stop(); stopWatch()
})
