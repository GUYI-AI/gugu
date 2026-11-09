import { describe, expect, it } from 'vitest';
import type { GuguMcpContext } from '../../../../apps/desktop/electron/acp-engine-utils';
import { guguMcpToolScope, passwordNativeMcpIdentity } from '../../../../apps/desktop/electron/mcp/password-native-identity';

function context(extra: object = {}): GuguMcpContext {
  return { kind: 'session-only', expectedOwnerUserId: 'owner', subjectId: 'agent', ...extra } as GuguMcpContext;
}

describe('native password identity metadata', () => {
  it('never reconstructs a missing native session from grantKey', () => {
    expect(passwordNativeMcpIdentity(context({ grantKey: 'taskpage:claimed-session' }))).toBeUndefined();
    expect(passwordNativeMcpIdentity(context({ nativeSessionId: '', grantKey: 'taskpage:claimed-session' }))).toBeUndefined();
  });
  it('uses only the native bridge stamp and the original grant scope', () => {
    const value = context({ nativeSessionId: 'native-session', grantKey: 'taskpage:different-session' });
    expect(passwordNativeMcpIdentity(value)).toEqual({ ownerId: 'owner', subjectId: 'agent', sessionId: 'native-session', toolScope: 'session-only' });
    expect(Object.isFrozen(passwordNativeMcpIdentity(value))).toBe(true);
  });
  it.each(['expectedOwnerUserId', 'subjectId', 'nativeSessionId'])('rejects blank %s', key => {
    expect(passwordNativeMcpIdentity(context({ nativeSessionId: 'session', [key]: ' ' }))).toBeUndefined();
  });
  it('does not qualify a runtime fork as an independently authenticated Agent', () => {
    expect(passwordNativeMcpIdentity(context({ kind: 'social', nativeSessionId: 'session', forkOf: 'parent' }))).toBeUndefined();
  });
  it.each([
    [{ kind: 'session-only' }, 'session-only'],
    [{ kind: 'social' }, 'gugu'],
    [{ kind: 'social', runSessionAction: async () => {} }, 'gugu+session'],
    [{ kind: 'social', forkOf: 'parent' }, 'runtime-fork'],
    [{ kind: 'social', forkOf: 'parent', runSessionAction: async () => {} }, 'runtime-fork+session'],
    [{ kind: 'social', personalAssistant: true }, 'gugu:assistant'],
  ] as const)('preserves existing grant scope for %j', (extra, expected) => {
    expect(guguMcpToolScope(context(extra))).toBe(expected);
  });
});
