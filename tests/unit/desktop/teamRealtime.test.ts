import { expect, it } from 'vitest'
import { identityRealtimeOptions, identityRealtimeTopic, realtimeScopeChanged, verifiedTeamRealtimeScope } from '../../../apps/desktop/shared/team-realtime'

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
