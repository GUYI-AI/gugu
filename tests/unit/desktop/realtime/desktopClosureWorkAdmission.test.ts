import { describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { createDeviceRuntimeHostLoop } from '@gugu/core/cloud/deviceRuntimeHost'
import { isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'

describe('native account-closure publisher admission', () => {
  it('refuses paused A without establishing another identity or contacting the backend', async () => {
    const env = await isolatedGuguEnv('closure-publisher-')
    const client = vi.fn(() => { throw new Error('Unexpected backend access') })
    const host = createDeviceRuntimeHostLoop({ env, authProvider: { getAuth: async () => ({ userId: 'A', accessToken: 'fixture' }) },
      ownerWorkAllowed: async owner => owner !== 'A', makeIdentityClient: client })
    try {
      expect(await host.tickOnce()).toEqual({ skipped: true })
      await host.quiesceOwnerForClosure!('A')
      await expect(host.quiesceOwnerForClosure!('B')).rejects.toThrow('not paused')
      expect(client).not.toHaveBeenCalled()
      expect(host.getDebugSnapshot().status).not.toBe('stopped')
    } finally { await host.stop(); await rm(env.HOME!, { recursive: true, force: true }) }
  })
  it('waits for an admitted auth read before confirming the native publisher is quiet', async () => {
    const env = await isolatedGuguEnv('closure-flight-'), entered = Promise.withResolvers<void>(), auth = Promise.withResolvers<void>()
    let allowed = true
    const client = vi.fn(() => { throw new Error('Unexpected backend access') })
    const host = createDeviceRuntimeHostLoop({ env, authProvider: { getAuth: async () => { entered.resolve(); await auth.promise; return { userId: 'A', accessToken: 'fixture' } } },
      ownerWorkAllowed: async () => allowed, makeIdentityClient: client })
    try {
      const tick = host.tickOnce(); await entered.promise; allowed = false
      let quiet = false
      const waiting = host.quiesceOwnerForClosure!('A').then(() => { quiet = true })
      await Promise.resolve(); expect(quiet).toBe(false)
      auth.resolve(); await tick; await waiting
      expect(quiet).toBe(true); expect(client).not.toHaveBeenCalled()
    } finally { auth.resolve(); await host.stop(); await rm(env.HOME!, { recursive: true, force: true }) }
  })
})
