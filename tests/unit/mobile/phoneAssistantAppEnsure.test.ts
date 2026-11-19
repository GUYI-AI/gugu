import { describe, expect, it, vi } from 'vitest'
import { GUGU_APPS_REPO } from '../../../apps/desktop/src/session/shared/extensions/market'
import type { PhoneInstallRecord } from '../../../apps/desktop/src/components/appSlot/phoneApps'
import { createPhoneAssistantAppEnsure, phoneAssistantAppHere } from '../../../apps/desktop/src/components/appSlot/phoneAssistantAppEnsure'

/**
 * #1931 on a phone: the assistant App put in by itself where the account has an assistant — from the market as gugu's own,
 * in the background, retried with the desktop's backoff, never asked. "In" = a copy the phone trusts: the person's own copy
 * (from a chat, switched off) is left as it is; gugu's market copy the phone does not trust gets the release over it.
 */

/** gugu's market copy of `version`, in its release folder unless `path` says otherwise. */
const gugus = (version: string, path = `releases/gugu-assistant/${version}`): PhoneInstallRecord => ({
  origin: 'market', marketSource: { repo: GUGU_APPS_REPO, path, commit: 'a'.repeat(40) }, manifestDigest: `digest-${version}`, version, enabled: true,
})

function world(overrides: { installed?: PhoneInstallRecord | null; fails?: number; puts?: PhoneInstallRecord } = {}) {
  let installed: PhoneInstallRecord | null = overrides.installed ?? null
  let fails = overrides.fails ?? 0
  const install = vi.fn(async (_over: unknown) => {
    if (fails > 0) { fails -= 1; throw new Error('market down') }
    installed = overrides.puts ?? gugus('1.0.0')
  })
  const sleep = vi.fn(async (_ms: number) => undefined)
  const ensure = createPhoneAssistantAppEnsure({ installed: () => phoneAssistantAppHere(installed), install, ready: async () => undefined, sleep }, [10, 20, 30])
  return { ensure, install, sleep, uninstall: () => { installed = null } }
}

describe('the assistant App on a phone (ensure)', () => {
  it('goes in, unasked, once the account\'s assistant is known, and not before', async () => {
    const w = world()
    expect(await w.ensure.ensure(false)).toBe('not-needed')
    expect(w.install).not.toHaveBeenCalled()
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.install).toHaveBeenCalledTimes(1)
    expect(await w.ensure.ensure(true)).toBe('present')
    expect(w.install).toHaveBeenCalledTimes(1)
  })

  it('leaves the person\'s copy as it is: from a chat, or switched off', async () => {
    for (const copy of [{ ...gugus('0.1.0'), origin: 'attachment' as const }, { ...gugus('0.1.0', 'apps/gugu-assistant'), enabled: false }]) {
      const w = world({ installed: copy })
      expect(await w.ensure.ensure(true)).toBe('own')
      expect(w.install).not.toHaveBeenCalled()
    }
  })

  it('a trusted copy here is in: nothing to do', async () => {
    const w = world({ installed: gugus('1.0.0') })
    expect(await w.ensure.ensure(true)).toBe('present')
    expect(w.install).not.toHaveBeenCalled()
  })

  it('gugu\'s market copy the phone does not trust (an old build outside its release folder) gets the release over it, named as looked at', async () => {
    const w = world({ installed: gugus('0.1.0', 'apps/gugu-assistant') })
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.install).toHaveBeenCalledWith({ version: '0.1.0', manifestDigest: 'digest-0.1.0' })
    expect(await w.ensure.ensure(true)).toBe('present')
    expect(w.install).toHaveBeenCalledTimes(1)
  })

  it('a copy it put in that the phone still does not trust is not put in again, however often the store changes', async () => {
    const w = world({ installed: gugus('0.1.0', 'apps/gugu-assistant'), puts: gugus('1.0.0', 'apps/gugu-assistant') })
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(await w.ensure.ensure(true)).toBe('untrusted')
    expect(await w.ensure.ensure(true)).toBe('untrusted')
    expect(w.install).toHaveBeenCalledTimes(1)
  })

  it('goes back in after the person removed it, while they have an assistant', async () => {
    const w = world()
    await w.ensure.ensure(true)
    w.uninstall()
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.install).toHaveBeenCalledTimes(2)
  })

  it('retries with backoff, says stuck once the window is spent, and clears it when it finally goes in', async () => {
    const w = world({ fails: 3 })
    const heard = vi.fn()
    w.ensure.subscribe(heard)
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 30])
    // Stuck when the last wait of the window began; cleared once it went in.
    expect(heard).toHaveBeenCalledTimes(2)
    expect(w.ensure.stuck()).toBe(false)
  })

  it('joins one attempt however often it is asked while running', async () => {
    const w = world({ fails: 1 })
    const [a, b] = await Promise.all([w.ensure.ensure(true), w.ensure.ensure(true)])
    expect([a, b]).toEqual(['installed', 'installed'])
    expect(w.install).toHaveBeenCalledTimes(2)
  })
})
