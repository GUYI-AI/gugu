import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { watchCredentialLoginCompletion } from './credential-handoff-completion';
import { CredentialHandoff } from './credential-handoff';
import { registerPrivateCredentialSurface } from './credential-isolation-registry';
import type { CredentialLoginPersonView, VaultUseCapability } from './credential-use-contract';
import type { PostUseAuditProof } from './credential-settlement-contract';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const binding = { requestId: randomUUID(), useId: randomUUID(), accountId: randomUUID(), installationId: randomUUID(),
    agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(), loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(),
    documentId: randomUUID(), frameId: randomUUID(), formFingerprint: randomUUID(), credentialId: randomUUID(), credentialVersion: '1',
    lockEpoch: randomUUID(), origin: 'https://login.example.test', operation: 'login-submit' as const };
  const page = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; }, debugger: { isAttached: () => false } });
  const release = registerPrivateCredentialSurface({ loginSurfaceId: binding.loginSurfaceId, loginSurfaceEpoch: binding.loginSurfaceEpoch,
    browserId: binding.browserId, partition: randomUUID(), contents: page as unknown as WebContents });
  cleanups.push(() => { page.destroyed = true; page.emit('destroyed'); release(); });
  const view: CredentialLoginPersonView = { requestId: binding.requestId, useId: binding.useId, outcome: 'submitted_unconfirmed',
    handoff: 'isolated_login_active', canRequestContinue: false };
  const lifecycle = { refresh: vi.fn(async () => view), invalidate: vi.fn(() => {}) };
  return { binding, page, lifecycle, view };
}

it('rechecks a slow completed native navigation and automatically hands back without person continuation', async () => {
  const f = fixture(), capability = {} as VaultUseCapability, proof = {} as PostUseAuditProof;
  let complete = false;
  const confirm = vi.fn(() => {});
  const lifecycle = new CredentialHandoff(f.binding, capability, { assertCurrent() {}, verifyLocalContinue: () => false,
    permission: { signal: new AbortController().signal, revalidate: async () => {}, assertCurrent() {} },
    readCompletion: async () => ({ loginSurfaceId: f.binding.loginSurfaceId, loginSurfaceEpoch: f.binding.loginSurfaceEpoch,
      surfaceEpoch: f.binding.loginSurfaceEpoch, documentId: complete ? randomUUID() : f.binding.documentId, documentEpoch: '1',
      topDocumentChanged: complete, filledPasswordFieldsAbsent: complete, requiresPersonInteraction: !complete }),
    prepareHandoff: async () => ({ commit: async () => {}, retract() {}, confirm, discard: async () => {} }),
  }, { clearFilledFields: async () => ({ status: 'cleared' }), destroy: async () => {
    f.page.destroyed = true; f.page.emit('destroyed'); return { status: 'destroyed' };
  } },
  { quiesce: async () => true, clear: async () => true, verify: async () => true },
  { matches: () => true, appendOutcome: async () => ({ status: 'recorded', eventId: randomUUID(), recordId: randomUUID(), proof }) }, new AbortController().signal);
  const close = watchCredentialLoginCompletion(f.binding, lifecycle); cleanups.push(close);
  expect((await lifecycle.settle(capability, f.binding, { outcome: 'submitted_unconfirmed', effectPossible: true,
    audit: { status: 'recorded', eventId: randomUUID(), recordId: randomUUID(), proof } })).handoff).toBe('person_interaction_required');
  complete = true; f.page.emit('did-stop-loading');
  await vi.waitFor(() => expect(lifecycle.view().handoff).toBe('handed_back'));
  expect(confirm.mock.calls.length).toBe(1);
});

it('coalesces event bursts and permits only one real refresh at a time', async () => {
  const f = fixture();
  let finish!: (view: CredentialLoginPersonView) => void;
  f.lifecycle.refresh.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  cleanups.push(watchCredentialLoginCompletion(f.binding, f.lifecycle));
  f.page.emit('dom-ready'); f.page.emit('did-navigate'); f.page.emit('did-stop-loading');
  await Promise.resolve();
  expect(f.lifecycle.refresh.mock.calls.length).toBe(1);
  f.page.emit('dom-ready'); f.page.emit('did-stop-loading');
  expect(f.lifecycle.refresh.mock.calls.length).toBe(1);
  finish(f.view);
  await vi.waitFor(() => expect(f.lifecycle.refresh.mock.calls.length).toBe(2));
});

it('ignores subframe events and removes listeners on actual native destruction', async () => {
  const f = fixture(); cleanups.push(watchCredentialLoginCompletion(f.binding, f.lifecycle));
  f.page.emit('did-navigate-in-page', {}, f.binding.origin, false);
  await Promise.resolve(); expect(f.lifecycle.refresh.mock.calls.length).toBe(0);
  f.page.emit('did-navigate-in-page', {}, f.binding.origin, true);
  await vi.waitFor(() => expect(f.lifecycle.refresh.mock.calls.length).toBe(1));
  f.page.destroyed = true; f.page.emit('destroyed'); f.page.emit('did-stop-loading');
  await Promise.resolve(); expect(f.lifecycle.refresh.mock.calls.length).toBe(1);
  expect(f.page.listenerCount('dom-ready') + f.page.listenerCount('did-stop-loading')).toBe(0);
});

it('latches an unexpected refresh failure without exposing its payload or accepting a late event', async () => {
  const f = fixture(); f.lifecycle.refresh.mockRejectedValueOnce(new Error(randomUUID()));
  watchCredentialLoginCompletion(f.binding, f.lifecycle);
  f.page.emit('did-stop-loading');
  await vi.waitFor(() => expect(f.lifecycle.invalidate.mock.calls.length).toBe(1));
  f.page.emit('did-navigate'); await Promise.resolve();
  expect(f.lifecycle.refresh.mock.calls.length).toBe(1);
});

it('rejects a guessed private identity or another browser and captures fixed lifecycle methods', async () => {
  const f = fixture();
  expect(() => watchCredentialLoginCompletion({ ...f.binding, loginSurfaceEpoch: randomUUID() }, f.lifecycle)).toThrow();
  expect(() => watchCredentialLoginCompletion({ ...f.binding, browserId: randomUUID() }, f.lifecycle)).toThrow();
  const original = f.lifecycle.refresh;
  cleanups.push(watchCredentialLoginCompletion(f.binding, f.lifecycle));
  f.lifecycle.refresh = vi.fn(async () => { throw new Error('replaced'); });
  f.page.emit('did-stop-loading');
  await vi.waitFor(() => expect(original.mock.calls.length).toBe(1));
  expect(f.lifecycle.refresh.mock.calls.length).toBe(0);
});
