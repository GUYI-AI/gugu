import { expect, it, vi } from 'vitest'
import { createRealtimeIdentityReader, publishTeamRealtimeRpc } from '../../../apps/desktop/shared/team-realtime-http'

const token = (kind = 'team_member', id = 'team-principal') => `head.${Buffer.from(JSON.stringify({ sub: id, app_metadata: { gugu_account_kind: kind } })).toString('base64url')}.signature`
const profile = () => ({ realtime_namespace: 'opaque-live-session:', membership_revision: 7, team: { id: 'team-a' },
  membership: { id: 'member-a', identity_id: 'team-principal', state: 'active', revision: 7 } })
const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))

it('does not add profile requests to personal or legacy account paths', async () => {
  const fetcher = vi.fn()
  for (const value of [null, 'legacy-personal-token', token('personal')]) {
    const context = await createRealtimeIdentityReader(async () => value, fetcher).read()
    expect(context.scope).toEqual({ kind: 'personal' })
  }
  expect(fetcher).not.toHaveBeenCalled()
})
it('reads only the authenticated profile and preserves the complete opaque namespace', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => reply(profile()))
  const reader = createRealtimeIdentityReader(async () => token(), fetcher)
  expect((await reader.read()).scope).toEqual({ kind: 'team', namespace: 'opaque-live-session:', membershipRevision: 7 })
  await reader.read(); expect(fetcher).toHaveBeenCalledTimes(1)
  await reader.read(true); expect(fetcher).toHaveBeenCalledTimes(2)
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/functions\/v1\/team-accounts\?action=profile$/)
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${token()}` } })
})
it.each(['namespace', 'principal', 'state', 'revision'])('refuses a team profile with invalid %s without a personal fallback', async field => {
  const value = profile()
  if (field === 'namespace') value.realtime_namespace = ''
  if (field === 'principal') value.membership.identity_id = 'another-principal'
  if (field === 'state') value.membership.state = 'disabled'
  if (field === 'revision') value.membership_revision++
  const reader = createRealtimeIdentityReader(async () => token(), async () => reply(value))
  await expect(reader.read()).rejects.toThrow('Realtime identity is unavailable')
})
it('does not fall back on a denied profile or an unknown team account marker', async () => {
  const reader = createRealtimeIdentityReader(async () => token(), async () => new Response('private server diagnostic', { status: 403 }))
  await expect(reader.read()).rejects.toThrow('Realtime identity is unavailable')
  const fetcher = vi.fn()
  await expect(createRealtimeIdentityReader(async () => token('team_login_anchor'), fetcher).read()).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it.each([200, 204])('accepts the protected publisher SQL void success (%s) without a raw broadcast', async status => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(status === 204 ? null : 'null', { status }))
  const args = { p_topic: 'gugu:d1:rpc:asker1', p_event: 'broadcast', p_payload: { id: 'request-1' } }
  expect(await publishTeamRealtimeRpc(fetcher, token(), args)).toEqual({ error: null })
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/rest\/v1\/rpc\/team_publish_realtime$/)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(args)
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${token()}` })
})
it.each([new Response('private backend diagnostic', { status: 403 }), new Response('{}'), new Response('<html>wrong upstream</html>')])('rejects denied or non-void publication responses', async response => {
  const result = await publishTeamRealtimeRpc(async () => response, token(), { p_topic: 'original', p_payload: {}, p_event: 'broadcast' })
  expect(result.error?.message).toBe('Realtime identity is unavailable')
})
