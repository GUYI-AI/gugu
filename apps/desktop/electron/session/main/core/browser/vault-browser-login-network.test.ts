import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { markVaultLoginNetworkInstalled, protectVaultLoginNetwork, vaultLoginRequestBlocked, vaultLoginResponseBlocked, vaultLoginResponseHeaders } from './vault-browser-login-network';
import { bindRemoteBrowser, installRemoteLoopbackRequests, setRemoteLoopbackForwarding, unbindRemoteBrowser } from './remote-loopback-requests';

const request = { id: 10, url: 'https://example.test/session', method: 'POST', resourceType: 'mainFrame', webContentsId: 7,
  frame: { processId: 3, routingId: 4, parent: null }, uploadData: [{}] };
function fixture() {
  const session = {} as Session; markVaultLoginNetworkInstalled(session, 'requests'); markVaultLoginNetworkInstalled(session, 'responses');
  const guard = protectVaultLoginNetwork(session, 7, 'https://example.test'); guard.beginSensitive();
  const current = vi.fn();
  return { session, guard, current, arm: () => guard.arm(request.url, '3:4', current) };
}

describe('private login network transport protection', () => {
  it('requires an installed composed chain and one private surface per partition', () => {
    expect(() => protectVaultLoginNetwork({} as Session, 7, 'https://example.test')).toThrow();
    const f = fixture(); expect(() => protectVaultLoginNetwork(f.session, 8, 'https://example.test')).toThrow();
  });
  it('allows one exact native POST and blocks repeats, even with a new request ID', () => {
    const f = fixture(); expect(vaultLoginRequestBlocked(f.session, request)).toBe(true);
    f.arm(); expect(vaultLoginRequestBlocked(f.session, request)).toBe(false);
    expect(f.current).toHaveBeenCalledTimes(1);
    expect(vaultLoginRequestBlocked(f.session, request)).toBe(true);
    expect(vaultLoginRequestBlocked(f.session, { ...request, id: 11 })).toBe(true);
  });
  it.each([
    { url: 'http://example.test/session' }, { url: 'https://sub.example.test/session' },
    { url: 'https://example.test:8443/session' }, { url: 'https://examp1e.test/session' },
    { resourceType: 'subFrame' }, { resourceType: 'xhr' }, { frame: null },
    { frame: { processId: 3, routingId: 4, parent: {} } }, { url: 'https://example.test/changed' },
  ])('blocks an unapproved transport destination/frame: %j', change => {
    const f = fixture(); f.arm(); expect(vaultLoginRequestBlocked(f.session, { ...request, ...change })).toBe(true);
  });
  it('fails closed if approval expires while Chromium queues the request', () => {
    const f = fixture(); f.arm(); f.current.mockImplementation(() => { throw new Error('invalidated'); });
    expect(vaultLoginRequestBlocked(f.session, request)).toBe(true);
    expect(() => f.arm()).toThrow();
  });
  it('allows a separately guarded person continuation only after the password transport actually passed', () => {
    const f = fixture();
    expect(() => f.guard.armPerson('https://example.test/otp', '3:4', f.current)).toThrow();
    f.arm(); expect(vaultLoginRequestBlocked(f.session, request)).toBe(false);
    f.guard.armPerson('https://example.test/otp', '3:4', f.current);
    const otp = { ...request, id: 20, url: 'https://example.test/otp' };
    expect(vaultLoginRequestBlocked(f.session, otp)).toBe(false);
    expect(vaultLoginRequestBlocked(f.session, { ...otp, id: 21 })).toBe(true);
    expect(vaultLoginResponseBlocked(f.session, { id: 20, statusCode: 307 })).toBe(true);
    expect(() => f.arm()).toThrow(); // The original password reservation is never restored.
  });
  it('rechecks lifecycle revocation on the person request and cannot continue a rejected password request', () => {
    const f = fixture(); f.arm(); expect(vaultLoginRequestBlocked(f.session, request)).toBe(false);
    f.guard.armPerson('https://example.test/otp', '3:4', f.current);
    f.current.mockImplementation(() => { throw new Error('revoked'); });
    expect(vaultLoginRequestBlocked(f.session, { ...request, id: 20, url: 'https://example.test/otp' })).toBe(true);
    const next = fixture(); next.arm(); next.current.mockImplementation(() => { throw new Error('revoked'); });
    expect(vaultLoginRequestBlocked(next.session, request)).toBe(true);
    expect(() => next.guard.armPerson('https://example.test/otp', '3:4', () => {})).toThrow();
  });
  it('blocks 307/308 body replays on the same origin and cross-origin redirect GETs', () => {
    const f = fixture(); f.arm(); expect(vaultLoginRequestBlocked(f.session, request)).toBe(false);
    expect(vaultLoginResponseBlocked(f.session, { id: 10, statusCode: 307 })).toBe(true);
    expect(vaultLoginResponseBlocked(f.session, { id: 10, statusCode: 308 })).toBe(true);
    expect(vaultLoginResponseBlocked(f.session, { id: 10, statusCode: 303 })).toBe(false);
    expect(vaultLoginRequestBlocked(f.session, { ...request, method: 'GET', uploadData: [], url: 'https://other.test/' })).toBe(true);
    expect(vaultLoginRequestBlocked(f.session, { ...request, method: 'GET', uploadData: [], url: 'https://example.test/done' })).toBe(false);
  });
  it('blocks unattributed worker uploads and late requests after destruction, keeping ordinary tabs unchanged', () => {
    const f = fixture();
    expect(vaultLoginRequestBlocked(f.session, { ...request, webContentsId: undefined })).toBe(true);
    expect(vaultLoginRequestBlocked(f.session, { ...request, webContentsId: 20 })).toBe(false);
    f.guard.close();
    expect(vaultLoginRequestBlocked(f.session, { ...request, method: 'GET', uploadData: [] })).toBe(true);
  });
  it('composes with the existing loopback chain instead of overwriting its listener', async () => {
    let listener: (details: typeof request, callback: (answer: unknown) => void) => void = () => {};
    const install = vi.fn(handler => { listener = handler; });
    const session = { webRequest: { onBeforeRequest: install } } as unknown as Session;
    installRemoteLoopbackRequests(session, () => null, vi.fn());
    expect(() => protectVaultLoginNetwork(session, 7, 'https://example.test')).toThrow();
    markVaultLoginNetworkInstalled(session, 'responses');
    const guard = protectVaultLoginNetwork(session, 7, 'https://example.test'); guard.beginSensitive();
    const result = vi.fn(); listener(request, result);
    expect(result).toHaveBeenCalledWith({ cancel: true });
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('prevents the private response from being cached and preserves session cookies', () => {
    const f = fixture();
    const headers = vaultLoginResponseHeaders(f.session, { webContentsId: 7,
      responseHeaders: { 'cache-control': ['public,max-age=3600'], 'Set-Cookie': ['session=synthetic'] } });
    expect(headers).toEqual({ 'Cache-Control': ['no-store'], Pragma: ['no-cache'], Expires: ['0'], 'Set-Cookie': ['session=synthetic'] });
    expect(vaultLoginResponseHeaders(f.session, { webContentsId: 8 })).toBeNull();
  });
  it('keeps the actual remote forwarding callback reachable beside a private login guard', async () => {
    let listener: (details: typeof request, callback: (answer: unknown) => void) => void = () => {};
    const session = { webRequest: { onBeforeRequest: (handler: typeof listener) => { listener = handler; } } } as unknown as Session;
    const open = vi.fn(async () => 9090);
    bindRemoteBrowser('remote', { deviceId: 'device', sessionId: 'session' });
    setRemoteLoopbackForwarding({ open, remoteForLocal: () => null, status: () => null });
    try {
      installRemoteLoopbackRequests(session, id => id === 4 ? 'remote' : null, vi.fn());
      markVaultLoginNetworkInstalled(session, 'responses');
      protectVaultLoginNetwork(session, 7, 'https://example.test').beginSensitive();
      const answer = await new Promise(resolve => listener({ ...request, id: 20, webContentsId: 4,
        method: 'GET', uploadData: [], url: 'http://localhost:8080/path' }, resolve));
      expect(answer).toEqual({ redirectURL: 'http://127.0.0.1:9090/path' });
      expect(open).toHaveBeenCalledTimes(1);
    } finally { unbindRemoteBrowser('remote'); setRemoteLoopbackForwarding(null); }
  });
});
