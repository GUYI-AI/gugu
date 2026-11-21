// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

/** The approval sheet reads the request the link names through a replica; deciding is its own command. */
const api = vi.hoisted(() => ({ read: vi.fn(), decide: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/server-login/serverLoginApproval', () => ({ readServerLoginRequest: api.read, decideServerLogin: api.decide }))
const { ServerLoginApproveSheet } = await import('../../../apps/desktop/src/mobile/server-login/ServerLoginApproveSheet')
const { followRendererSession } = await import('../../../apps/desktop/src/lib/replica')

const request = { code: 'ABCD', state: 'pending', machine: { hostname: 'box', platform: 'linux', arch: 'x64', user: 'me' }, requesterIp: null }
const state = () => document.querySelector('[data-approve-state]')?.getAttribute('data-approve-state')
const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })

beforeEach(() => { api.read.mockReset(); api.decide.mockReset(); followRendererSession('SIGNED_IN', 'owner') })

it('loading until the request is read, then the request; allowing shows the final answer', async () => {
  api.read.mockResolvedValue(request)
  api.decide.mockResolvedValue({ state: 'approved', refusal: null })
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(ServerLoginApproveSheet, { code: 'ABCD', onDone: () => undefined }))
  await settle()
  expect(state()).toBe('request')
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="server-login-approve-allow"]')!.click() })
  await settle()
  expect(state()).toBe('approved')
  expect(api.decide).toHaveBeenCalledWith('ABCD', true)
  harness.cleanup()
})

it('a request that cannot be read says so (not found, or failed)', async () => {
  api.read.mockRejectedValue(new Error('not_found'))
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(ServerLoginApproveSheet, { code: 'GONE', onDone: () => undefined }))
  await settle()
  expect(state()).toBe('failed')
  harness.cleanup()
})

it('read on an earlier open, the read on this open failing: the request stays, the failure said with a retry', async () => {
  api.read.mockResolvedValue({ ...request, code: 'KEPT' })
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(ServerLoginApproveSheet, { code: 'KEPT', onDone: () => undefined }))
  await settle()
  expect(state()).toBe('request')
  expect(document.querySelector('[data-refresh-failed]')).toBeNull()
  // Opened again (the first sheet still holds the entry): the read on this open fails.
  api.read.mockRejectedValue(new Error('network down'))
  const again = createReactHarness()
  await renderWithAppProviders(again, createNode(ServerLoginApproveSheet, { code: 'KEPT', onDone: () => undefined }))
  await settle()
  expect(api.read).toHaveBeenCalledTimes(2)
  expect(state()).toBe('request')
  expect(document.querySelector('[data-refresh-failed]')).not.toBeNull()
  api.read.mockResolvedValue({ ...request, code: 'KEPT' })
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-refresh-failed] button')!.click() })
  await settle()
  expect(document.querySelector('[data-refresh-failed]')).toBeNull()
  again.cleanup()
  harness.cleanup()
})
