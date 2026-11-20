import { expect, it, vi } from 'vitest';
import { codexAccessProjection, codexNativeNeedsRefresh, codexOAuthIdentity, createCodexNativeAuthAuthority, refreshNativeCodexThroughCli } from './codex-native-auth.mjs';

const now = Date.UTC(2026, 10, 20);
const jwt = (value: object) => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;
function auth(person = 'alice', workspace = 'work', seconds = 3600) {
  return { auth_mode: 'chatgpt', tokens: {
    account_id: workspace, refresh_token: 'synthetic-refresh-token-never-export',
    id_token: jwt({ sub: person, email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_user_id: person, chatgpt_account_id: workspace, chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ exp: now / 1000 + seconds }),
  } };
}

it('identifies people and workspaces independently of a rotated token', () => {
  expect(codexOAuthIdentity(auth())).toBe(codexOAuthIdentity(auth('alice', 'work', 100)));
  expect(codexOAuthIdentity(auth('bob'))).not.toBe(codexOAuthIdentity(auth()));
  expect(codexOAuthIdentity(auth('alice', 'other'))).not.toBe(codexOAuthIdentity(auth()));
});

it('does not merge contradictory workspace claims or inactive OAuth in API-key mode', () => {
  expect(codexOAuthIdentity({ ...auth(), tokens: { ...auth().tokens, account_id: 'other' } })).toBeNull();
  expect(codexOAuthIdentity({ ...auth(), auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-key' })).toBeNull();
  expect(codexOAuthIdentity({ ...auth(), auth_mode: undefined, OPENAI_API_KEY: 'synthetic-key' })).toBeNull();
});

it('projects only access authentication, never the refresh token or extra source fields', () => {
  const source = { ...auth(), extra: 'not-exported' };
  const view = codexAccessProjection(source);
  expect(view.chatgptAccountId).toBe('work');
  expect(view.chatgptPlanType).toBe('plus');
  expect(view.credentials.tokens).toEqual({ id_token: source.tokens.id_token, access_token: source.tokens.access_token, account_id: 'work' });
  expect(JSON.stringify(view)).not.toContain(source.tokens.refresh_token);
  expect(JSON.stringify(view)).not.toContain('not-exported');
});

it('matches the CLI five-minute boundary and legacy eight-day comparison exactly', () => {
  expect(codexNativeNeedsRefresh(auth('alice', 'work', 301), now)).toBe(false);
  expect(codexNativeNeedsRefresh(auth('alice', 'work', 300), now)).toBe(true);
  const legacy = { ...auth(), tokens: { ...auth().tokens, access_token: jwt({}) }, last_refresh: new Date(now - 8 * 86400000).toISOString() };
  expect(codexNativeNeedsRefresh(legacy, now)).toBe(false);
  expect(codexNativeNeedsRefresh({ ...legacy, last_refresh: new Date(now - 8 * 86400000 - 1).toISOString() }, now)).toBe(true);
});

function authority(initial = auth('alice', 'work', 30), serialize = async <T>(work: () => Promise<T>) => work()) {
  let source = initial;
  const refresh = vi.fn(async () => { source = auth(); });
  const read = vi.fn(async () => source);
  const access = createCodexNativeAuthAuthority({ read, refresh, serialize, identity: codexOAuthIdentity(initial)!, now: () => now });
  return { access, refresh, read, set: (next: typeof initial) => { source = next; } };
}

it('status reads and construction do not proactively refresh, even when close to expiry', async () => {
  const a = authority();
  expect(a.refresh).not.toHaveBeenCalled();
  await a.access();
  expect(a.refresh).not.toHaveBeenCalled();
});

it('an external CLI already refreshed: reread after admission skips our refresh', async () => {
  const fresh = auth();
  const a = authority(auth('alice', 'work', 30), async work => { a.set(fresh); return work(); });
  expect((await a.access({ useToken: true }))!.accessToken).toBe(fresh.tokens.access_token);
  expect(a.refresh).not.toHaveBeenCalled();
});

it('simultaneous token consumers share one CLI operation, then use its persisted token', async () => {
  const a = authority();
  const views = await Promise.all(Array.from({ length: 8 }, () => a.access({ useToken: true })));
  expect(a.refresh).toHaveBeenCalledTimes(1);
  expect(new Set(views.map(view => view!.accessToken)).size).toBe(1);
  await a.access({ useToken: true });
  expect(a.refresh).toHaveBeenCalledTimes(1);
});

it('an account response without a persisted new access token is not refresh success', async () => {
  const a = authority();
  a.refresh.mockImplementation(async () => {});
  await expect(a.access({ useToken: true })).rejects.toThrow('did not persist');
});

it('never supplies a replacement account under the previous identity', async () => {
  const a = authority();
  a.refresh.mockImplementation(async () => { a.set(auth('bob')); });
  await expect(a.access({ useToken: true })).rejects.toThrow('account changed');
});

it('rereads after a failed exchange and accepts a usable update from the external CLI', async () => {
  const a = authority();
  a.refresh.mockImplementation(async () => { a.set(auth()); throw new Error('old refresh generation rejected'); });
  expect((await a.access({ useToken: true }))!.accessToken).toBe(auth().tokens.access_token);
});

it('revocation with no persisted replacement remains a failure', async () => {
  const a = authority();
  a.refresh.mockRejectedValue(new Error('refresh token was revoked'));
  await expect(a.access({ useToken: true })).rejects.toThrow('refresh token was revoked');
  await expect(a.access()).rejects.toThrow('refresh token was revoked');
  expect(a.refresh).toHaveBeenCalledTimes(1);
  a.set(auth());
  expect(await a.access()).not.toBeNull();
});

it('CLI initialize already refreshed: do not issue an explicit second refresh RPC', async () => {
  const before = auth('alice', 'work', 30);
  const request = vi.fn(async () => undefined);
  await refreshNativeCodexThroughCli(async work => work({ request }), {
    read: async () => ({ ...auth(), tokens: { ...auth().tokens, access_token: jwt({ exp: Date.now() / 1000 + 3600 }) } }),
    identity: codexOAuthIdentity(before)!, accessToken: before.tokens.access_token,
  });
  expect(request).not.toHaveBeenCalled();
});

it('an unchanged generation after initialize still requests CLI-owned renewal', async () => {
  const before = auth(); const request = vi.fn(async () => undefined);
  await refreshNativeCodexThroughCli(async work => work({ request }), {
    read: async () => before, identity: codexOAuthIdentity(before)!, accessToken: before.tokens.access_token,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith('account/read', { refreshToken: true });
});

it('a stale unauthorized callback reuses the external CLI update without another exchange', async () => {
  const a = authority(auth());
  const expiredAccessToken = auth('alice', 'work', -30).tokens.access_token;
  await a.access({ useToken: true, unauthorizedToken: expiredAccessToken });
  expect(a.refresh).not.toHaveBeenCalled();
});
