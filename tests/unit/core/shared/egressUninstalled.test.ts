// @vitest-environment node
import { expect, it, vi } from 'vitest'

// tests/support/setup.ts installs a test egress; a fresh module copy shows what a host entry gets before it installs one.
it('fails loudly when a host process reaches the network before installing an egress', async () => {
  vi.resetModules()
  const { egress } = await import('@gugu/core/shared/egress')
  const global = vi.spyOn(globalThis, 'fetch')
  expect(() => egress.fetch('https://cloud.example/rest/v1/x')).toThrow(/no backend installed/)
  expect(() => egress.webSocket('wss://cloud.example/realtime')).toThrow(/no backend installed/)
  expect(global).not.toHaveBeenCalled()
  global.mockRestore()
})

it('a worker installs only the harness-environment transport, so a host request there fails loudly', async () => {
  vi.resetModules()
  const { installWorkerEgress } = await import('../../../../apps/desktop/electron/egress/install-node')
  const { egress, fetchWithEnv } = await import('@gugu/core/shared/egress')
  installWorkerEgress()
  expect(() => egress.fetch('https://cloud.example/rest/v1/x')).toThrow(/no backend installed/)
  // A just-released loopback port refuses: the environment transport is installed and reports a network failure.
  const { createServer } = await import('node:net')
  const server = createServer()
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
  await new Promise(resolve => server.close(resolve))
  await expect(fetchWithEnv({}, `http://127.0.0.1:${port}/`)).rejects.toMatchObject({ name: 'EgressError', kind: 'connect' })
})
