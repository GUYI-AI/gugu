import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import { until } from '../../support/awaitCondition'
import { mockTeamApi, teamSignIn } from '../../fixtures/teamEdition'
import { TeamApiError } from '../../../apps/desktop/src/features/team/errors'

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const fixture = vi.hoisted(() => ({
  callback: null as null | ((url: string) => void), nativeCallback: '',
  configs: [] as Array<{ storageKey: string; persistSession: boolean; autoRefreshToken: boolean; storage: Storage }>,
  signOut: vi.fn(async () => ({ error: null })), proof: null as Session | null,
}))
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: (config: typeof fixture.configs[number]) => {
  fixture.configs.push(config)
  return { auth: {
    signOut: fixture.signOut,
    signInWithOAuth: async ({ options }: { options: { redirectTo: string } }) => {
      config.storage.setItem(`${config.storageKey}-code-verifier`, 'synthetic-proof-verifier')
      const url = new URL('http://supabase.test.local/auth/v1/authorize')
      url.searchParams.set('provider', 'google'); url.searchParams.set('redirect_to', options.redirectTo); url.searchParams.set('code_challenge', 'synthetic-challenge')
      return { data: { url: url.href }, error: null }
    },
    exchangeCodeForSession: async () => ({ data: { session: fixture.proof }, error: null }),
  } }
} }))
vi.mock('@/lib/authCallbacks', () => ({ authCallbacks: {
  ready: async () => undefined, redirectTo: async () => 'gugu-dev://auth/callback',
  subscribe: (callback: (url: string) => void) => { fixture.callback = callback; return () => { fixture.callback = null } },
} }))
vi.mock('@/platform', () => ({ platform: { authCallbacks: {}, oauthBrowser: {
  openBrowser: async (url: string) => {
    const handoff = new URL(new URL(url).searchParams.get('redirect_to')!)
    fixture.nativeCallback = `${handoff.searchParams.get('scheme')}://auth/callback?gugu_oauth_attempt=${handoff.searchParams.get('gugu_oauth_attempt')}`
  },
} } }))
import { createTeamGoogleProof } from '../../../apps/desktop/src/features/team/googleProof'

let controller: ReturnType<typeof createTeamGoogleProof> | undefined
beforeEach(() => {
  fixture.configs.length = 0; fixture.nativeCallback = ''; fixture.callback = null; fixture.signOut.mockClear()
  fixture.proof = { ...teamSignIn().session, access_token: 'synthetic-personal-proof', user: { ...teamSignIn().session.user, app_metadata: {} } }
})
afterEach(async () => { await controller?.cancel(); controller = undefined })
async function deliverProof() {
  await until('the isolated proof flow opens its browser', () => ({ native: fixture.nativeCallback, callback: !!fixture.callback,
    clients: fixture.configs.length, verifier: fixture.configs[0]?.storage.getItem(`${fixture.configs[0]?.storageKey}-code-verifier`), signOuts: fixture.signOut.mock.calls.length }), value => !!value.native && value.callback)
  const url = new URL(fixture.nativeCallback); url.searchParams.set('code', 'synthetic-google-code')
  fixture.callback!(url.href)
}

it('keeps Google proof in private memory and returns only the separately issued team session', async () => {
  const api = mockTeamApi(), googleSignIn = vi.fn(api.googleSignIn)
  controller = createTeamGoogleProof({ ...api, googleSignIn })
  const result = controller.start(); void result.catch(() => undefined); await deliverProof()
  expect(await result).toEqual(teamSignIn())
  expect(googleSignIn).toHaveBeenCalledWith(fixture.proof, undefined)
  const config = fixture.configs[0]
  expect(config.storageKey).toMatch(/^gugu-team-google-proof-/)
  expect(config.autoRefreshToken).toBe(false)
  expect(config.storage.getItem(`${config.storageKey}-code-verifier`)).toBeNull()
  expect(fixture.signOut.mock.calls.every(args => JSON.stringify(args) === '[{"scope":"local"}]')).toBe(true)
})

it('reuses the verified Google proof for an inline team choice without another OAuth exchange', async () => {
  const api = mockTeamApi(), googleSignIn = vi.fn(api.googleSignIn).mockRejectedValueOnce(new TeamApiError('context_required'))
  controller = createTeamGoogleProof({ ...api, googleSignIn })
  const first = controller.start(); void first.catch(() => undefined); await deliverProof()
  await expect(first).rejects.toMatchObject({ code: 'context_required' })
  expect(await controller.choose('team-ming')).toEqual(teamSignIn())
  expect(googleSignIn.mock.calls[1]).toEqual([fixture.proof, 'team-ming'])
  expect(fixture.configs).toHaveLength(1)
})

it('refuses a late team exchange after cancellation and signs out only its temporary proof client', async () => {
  let finish!: (result: ReturnType<typeof teamSignIn>) => void
  const googleSignIn = vi.fn(() => new Promise<ReturnType<typeof teamSignIn>>(resolve => { finish = resolve }))
  controller = createTeamGoogleProof({ ...mockTeamApi(), googleSignIn })
  const result = controller.start(); void result.catch(() => undefined); await deliverProof()
  await until('the proof is being exchanged', () => googleSignIn.mock.calls.length === 1)
  await controller.cancel(); finish(teamSignIn())
  await expect(result).rejects.toMatchObject({ code: 'verification_expired' })
  expect(fixture.callback).toBeNull()
  expect(fixture.signOut).toHaveBeenLastCalledWith({ scope: 'local' })
})
