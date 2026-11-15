import { expect, it, vi } from 'vitest'
import { identityRealtimeOptions, identityRealtimeTopic, publishIdentityRealtimeBroadcast, realtimeScopeChanged, verifiedTeamRealtimeScope } from '../../../apps/desktop/shared/team-realtime'

it('keeps every personal topic byte-for-byte unchanged and forces private revision-scoped team topics', () => {
  const scope = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 7, namespace: 'gugu:team:t1:member:m1:r:7:' })
  for (const topic of ['user-events:u1', 'device-commands:d1', 'rpc:reply:r1']) {
    expect(identityRealtimeTopic({ kind: 'personal' }, topic)).toBe(topic)
    expect(identityRealtimeTopic(scope, topic)).toBe(`gugu:team:t1:member:m1:r:7:${topic}`)
  }
  const options = { config: { private: false, broadcast: { self: true } } }
  expect(identityRealtimeOptions(scope, options)).toEqual({ config: { private: true, broadcast: { self: true } } })
  expect(identityRealtimeOptions({ kind: 'personal' }, options)).toBe(options)
})
it('treats the full session-specific namespace as opaque and identifies session/revision changes', () => {
  expect(() => verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 8, namespace: undefined })).toThrow()
  const a = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 7, namespace: 'gugu:team:t1:member:m1:r:7:' })
  const b = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 8, namespace: 'gugu:team:t1:member:m1:r:8:' })
  expect(realtimeScopeChanged(a, b)).toBe(true)
  const opaque = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 7, namespace: 'server-controlled:opaque-session-fragment:' })
  expect(identityRealtimeTopic(opaque, 'user-events:u1')).toBe('server-controlled:opaque-session-fragment:user-events:u1')
  expect(realtimeScopeChanged(a, opaque)).toBe(true)
})

it('publishes a team broadcast through the protected RPC using the original topic and never raw send', async () => {
  const scope = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 7, namespace: 'opaque-server-session:' })
  const sendPersonal = vi.fn(), rpc = vi.fn(async () => ({ error: null }))
  const message = { type: 'broadcast' as const, event: 'broadcast', payload: { type: 'rpc.request', id: 'synthetic-request' } }
  expect(await publishIdentityRealtimeBroadcast(scope, 'gugu:d1:rpc:asker1', message, { sendPersonal, rpc })).toBe('ok')
  expect(rpc).toHaveBeenCalledWith('team_publish_realtime', { p_topic: 'gugu:d1:rpc:asker1', p_payload: message.payload, p_event: 'broadcast' })
  expect(sendPersonal).not.toHaveBeenCalled()
})
it.each(['denied', 'transport', 'malformed'])('does not fall back to raw send after team publication fails (%s)', async failure => {
  const scope = verifiedTeamRealtimeScope({ teamId: 't1', memberId: 'm1', membershipRevision: 7, namespace: 'opaque-server-session:' })
  const sendPersonal = vi.fn(), rpc = vi.fn(async () => {
    if (failure === 'transport') throw new Error('private backend diagnostic')
    return { error: failure === 'malformed' ? undefined : { message: 'private backend diagnostic' } }
  })
  const error = await publishIdentityRealtimeBroadcast(scope, 'gugu:d1:rpc', { type: 'broadcast', event: 'broadcast', payload: {} }, { sendPersonal, rpc }).catch(error => error)
  expect(error).toMatchObject({ message: 'Team realtime publication was refused' })
  expect(String(error)).not.toContain('private backend diagnostic')
  expect(sendPersonal).not.toHaveBeenCalled()
})
it('leaves the personal broadcast transport and its result unchanged', async () => {
  const sendPersonal = vi.fn(async () => 'personal-result'), rpc = vi.fn()
  const message = { type: 'broadcast' as const, event: 'broadcast', payload: { sequence: 7 } }
  expect(await publishIdentityRealtimeBroadcast({ kind: 'personal' }, 'original-topic', message, { sendPersonal, rpc })).toBe('personal-result')
  expect(sendPersonal).toHaveBeenCalledWith(message)
  expect(rpc).not.toHaveBeenCalled()
})
