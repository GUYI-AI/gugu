import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditedCredentialUseLease, CredentialUseBinding } from './credential-use-contract';
import { markVaultLoginNetworkInstalled } from './vault-browser-login-network';
import { VAULT_LOGIN_CHANNEL, VAULT_LOGIN_WORLD } from './vault-browser-login-protocol';

const mocks = vi.hoisted(() => ({ session: {} as Session, create: vi.fn(), exists: true, registered: true, remote: false }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: () => mocks.exists }));
vi.mock('electron', () => ({ session: { fromPartition: () => mocks.session }, WebContentsView: class {
  webContents = mocks.create(); setVisible() {} setBounds() {}
} }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: {
  isRegistered: () => mocks.registered, browserIdFor: (id: number) => id === 1 ? 'tab' : null,
} }));
vi.mock('./remote-loopback-requests', () => ({ remoteBrowserBinding: () => mocks.remote ? { deviceId: 'remote' } : null }));
import { VaultBrowserLoginSurface } from './vault-browser-login-surface';

let nextContentsId = 7;
class Contents extends EventEmitter {
  id = nextContentsId++; destroyed = false; url = ''; ipc = new EventEmitter();
  mainFrame = { processId: 3, routingId: 4, parent: null };
  debugger = { isAttached: () => false };
  replies: boolean[] = [];
  beforeGate: (() => void) | undefined;
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler() {} setBackgroundThrottling() {} stop() {}
  async loadURL(url: string) { this.emit('did-start-navigation', { isMainFrame: true }); this.url = url; }
  close() { this.destroyed = true; this.emit('destroyed'); }
  gate(phase: string, nonce: string) {
    this.beforeGate?.();
    const event = { sender: this, senderFrame: this.mainFrame, returnValue: { ok: false } };
    let answer = event.returnValue, replies = 0;
    Object.defineProperty(event, 'returnValue', { get: () => answer, set: value => { if (!replies++) answer = value; } });
    this.ipc.emit(VAULT_LOGIN_CHANNEL, event, { nonce, phase, documentId: 'document', formFingerprint: 'form', destination: 'https://example.test/post' });
    expect(replies).toBe(1); // Electron immediately replies on assignment, rather than after the listener returns.
    this.replies.push(event.returnValue.ok);
    return event.returnValue.ok;
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, scripts: { code: string }[]) => {
    expect(world).toBe(VAULT_LOGIN_WORLD);
    await Promise.resolve();
    return runInNewContext(scripts[0].code, { __guguVaultPrivateLogin: {
      review: () => ({ documentId: 'document', formFingerprint: 'form', destination: 'https://example.test/post' }),
      fill: (nonce: string) => this.gate('fill', nonce), submit: (nonce: string) => this.gate('submit', nonce),
      clear: () => true, completion: () => ({ documentId: 'document', filledPasswordFieldsAbsent: false, requiresPersonInteraction: true }),
    } });
  });
}
beforeEach(() => {
  mocks.create.mockReset(); mocks.exists = true; mocks.registered = true; mocks.remote = false;
  mocks.session = {} as Session; markVaultLoginNetworkInstalled(mocks.session, 'requests'); markVaultLoginNetworkInstalled(mocks.session, 'responses');
});
async function fixture(initialReady = true) {
  const contents = new Contents(); mocks.create.mockReturnValue(contents);
  let current = true;
  let ready = initialReady, sourceAlive = true;
  const assertCurrent = vi.fn(() => { if (!current) throw new Error('private host failure'); });
  const source = { id: 1, session: mocks.session, isDestroyed: () => !sourceAlive };
  const release = vi.fn();
  const policy = new AbortController();
  const permission = { signal: policy.signal,
    revalidate: vi.fn(async (_check: unknown) => { policy.signal.throwIfAborted(); }),
    assertCurrent: vi.fn((_binding: CredentialUseBinding) => { policy.signal.throwIfAborted(); }) };
  const host = { browserId: 'tab', partition: 'partition', agentContents: source as never,
    isolationReady: () => ready, assertCurrent, registerPrivateSurface: vi.fn(() => release), permission };
  const surface = new VaultBrowserLoginSurface(host, 'https://example.test');
  await surface.load('https://example.test/login');
  const actual = await surface.review({ form: '#form', account: '#account', password: '#password' });
  const binding: CredentialUseBinding = { ...actual, requestId: 'request', useId: 'use', accountId: 'owner', installationId: 'install',
    agentId: 'agent', sessionId: 'session', browserId: 'tab', credentialId: 'credential', credentialVersion: '1', lockEpoch: 'epoch', operation: 'login-submit' };
  const controller = new AbortController(), revoked = new AbortController();
  let prepareHook: () => void = () => {};
  const lease: AuditedCredentialUseLease = { signal: controller.signal, revokedSignal: revoked.signal,
    assertCurrent, claimSubmission: vi.fn(() => assertCurrent()), prepareSubmission: vi.fn(async () => { prepareHook(); }) };
  const password = Buffer.from(randomUUID());
  return { surface, contents, binding, lease, password, host, release, permission, policy, ready: (value: boolean) => { ready = value; },
    prepare: (hook: () => void) => { prepareHook = hook; }, retireSource: () => { sourceAlive = false; },
    revoke: () => { current = false; revoked.abort(); controller.abort(); },
    fill: () => surface.fill(binding, lease, Buffer.from(randomUUID()), password) };
}

describe('host-private login surface', () => {
  it('requires registration, local ownership and the private preload before creation', () => {
    const source = { id: 1, session: mocks.session, isDestroyed: () => false };
    const host = { browserId: 'tab', partition: 'partition', agentContents: source as never, isolationReady: () => false, assertCurrent() {}, registerPrivateSurface: () => () => {},
      permission: { signal: new AbortController().signal, revalidate: async () => {}, assertCurrent() {} } };
    mocks.registered = false;
    expect(() => new VaultBrowserLoginSurface(host, 'https://example.test')).toThrow('credential_login_unavailable');
    for (const reason of ['remote', 'registered', 'preload']) {
      mocks.remote = reason === 'remote'; mocks.registered = reason !== 'registered'; mocks.exists = reason !== 'preload';
      expect(() => new VaultBrowserLoginSurface({ ...host, isolationReady: () => true }, 'https://example.test')).toThrow();
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('allows inert preparation before isolation but refuses to release values until ready', async () => {
    const f = await fixture(false);
    f.host.isolationReady = () => true;
    await expect(f.fill()).rejects.toThrow('credential_login_unavailable');
    expect(f.contents.replies).toEqual([]); await f.surface.destroy(f.binding);
    const next = await fixture(false); next.retireSource(); next.ready(true);
    await next.fill(); expect(next.contents.replies).toEqual([true]);
    expect(next.host.registerPrivateSurface).toHaveBeenCalledTimes(1);
    await next.surface.destroy(next.binding); expect(next.release).toHaveBeenCalledTimes(1);
  });
  it('never inserts credentials into script source or wires console/capture listeners', async () => {
    const f = await fixture(); await f.fill();
    expect(f.contents.replies).toEqual([true]);
    expect(f.contents.executeJavaScriptInIsolatedWorld.mock.calls.every(([, scripts]) => !scripts[0].code.includes(f.password.toString()))).toBe(true);
    expect(f.contents.listenerCount('console-message')).toBe(0);
    expect(f.contents.listenerCount('page-title-updated')).toBe(0);
    await f.surface.destroy(f.binding);
  });
  it('rechecks after the queued command, before releasing the buffer to the preload', async () => {
    const f = await fixture(); f.contents.beforeGate = () => f.revoke();
    await expect(f.fill()).rejects.toThrow('credential_login_unavailable');
    expect(f.contents.replies).toEqual([false]); await f.surface.destroy(f.binding);
  });
  it('rechecks after pre-submit audit and never claims when that wait invalidates approval', async () => {
    const f = await fixture(); await f.fill();
    f.prepare(() => f.revoke());
    await expect(f.surface.submit(f.binding, f.lease)).rejects.toThrow('credential_login_unavailable');
    expect(f.lease.claimSubmission).not.toHaveBeenCalled(); await f.surface.destroy(f.binding);
  });
  it('claims the actual submission once and cannot retry it after success', async () => {
    const f = await fixture(); await f.fill(); await f.surface.submit(f.binding, f.lease);
    await expect(f.surface.submit(f.binding, f.lease)).rejects.toThrow();
    expect(f.lease.claimSubmission).toHaveBeenCalledTimes(1); await f.surface.destroy(f.binding);
  });
  it('awaits fill permission before any field operation and refuses a late revoked result', async () => {
    const f = await fixture();
    let done!: () => void;
    f.permission.revalidate.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
    const filling = f.fill();
    expect(f.contents.replies).toEqual([]);
    f.policy.abort(); done();
    await expect(filling).rejects.toThrow('credential_login_unavailable');
    expect(f.contents.replies).toEqual([]);
    expect(f.lease.claimSubmission).not.toHaveBeenCalled();
    await f.surface.destroy(f.binding);
  });
  it('reads fresh submit permission after the pre-submit audit and keeps the single claim unused on denial', async () => {
    const f = await fixture(); await f.fill();
    f.permission.revalidate.mockImplementationOnce(async () => {
      expect(f.lease.prepareSubmission).toHaveBeenCalledOnce();
      throw new Error('permission denied');
    });
    await expect(f.surface.submit(f.binding, f.lease)).rejects.toThrow('credential_login_unavailable');
    expect(f.permission.revalidate.mock.calls.at(-1)?.[0]).toEqual({ stage: 'before_submit', target: f.binding });
    expect(f.contents.replies).toEqual([true]);
    expect(f.lease.claimSubmission).not.toHaveBeenCalled();
    await f.surface.destroy(f.binding);
  });
  it('rejects a cloned lease and captures audit/current/signal methods before the sink runs', async () => {
    const f = await fixture(); f.prepare(() => { throw new Error('audit unavailable'); }); await f.fill();
    await expect(f.surface.submit(f.binding, { ...f.lease })).rejects.toThrow();
    Object.assign(f.lease, { prepareSubmission: async () => {}, assertCurrent: () => {}, signal: new AbortController().signal });
    await expect(f.surface.submit(f.binding, f.lease)).rejects.toThrow();
    expect(f.lease.claimSubmission).not.toHaveBeenCalled(); await f.surface.destroy(f.binding);
  });
  it('rejects an unexpected document after cleanup preparation and permits only intentional retirement', async () => {
    const f = await fixture(); await f.fill(); const completion = await f.surface.readCompletion(f.binding);
    f.contents.emit('did-start-navigation', { isMainFrame: true });
    expect(await f.surface.destroy(f.binding, completion.documentEpoch)).toEqual({ status: 'isolated_login_retained' });
    expect(f.contents.destroyed).toBe(false);
    expect(await f.surface.destroy(f.binding)).toEqual({ status: 'destroyed' });
    expect(() => f.surface.assertCurrent(f.binding)).not.toThrow();
    const unexpected = await fixture(); await unexpected.fill(); unexpected.contents.close();
    expect(() => unexpected.surface.assertCurrent(unexpected.binding)).toThrow();
  });
});
