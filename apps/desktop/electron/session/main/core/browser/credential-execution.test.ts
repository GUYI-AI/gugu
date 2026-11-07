import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PasswordPermissionGuard, PasswordPermissionPort, PasswordPermissionTarget } from '../../../../permissions/password-execution';
import type { CredentialUseBinding, CredentialUseLease } from './credential-use-contract';
import type { VaultUseCapability } from './credential-use-contract';
import type { CredentialUseResult } from '../../../../password-vault/contracts';
import { createCredentialExecution } from './credential-execution';

function fixture(portAvailable = true) {
  const target: PasswordPermissionTarget = { accountId: 'owner', installationId: 'install', agentId: 'agent', sessionId: 'session',
    browserId: 'tab', loginSurfaceId: 'surface', loginSurfaceEpoch: 'surface-epoch', documentId: 'document', frameId: 'frame',
    formFingerprint: 'form', credentialId: 'credential', credentialVersion: '1', lockEpoch: 'lock-epoch',
    origin: 'https://example.test', operation: 'login-submit' };
  const lifetime = new AbortController(), revoked = new AbortController(), person = Object.freeze({});
  let generation = randomUUID();
  const guard = (): PasswordPermissionGuard => {
    const captured = generation;
    return { signal: revoked.signal, requiresPersonConfirmation: true, assertCurrent() {
      revoked.signal.throwIfAborted(); if (generation !== captured) throw new Error('stale policy');
    } };
  };
  const port: PasswordPermissionPort = { revalidate: vi.fn(async () => guard()) };
  let lease: CredentialUseLease | undefined, usedBinding: CredentialUseBinding | undefined;
  const host = { current: vi.fn(() => true), isolationCurrent: vi.fn(() => true),
    verifyLocalDecision: vi.fn((_binding: CredentialUseBinding, evidence: unknown) => evidence === person),
    registerUse: vi.fn(), cleanup: vi.fn(async () => ({ status: 'cleaned' as const })),
    useCredential: vi.fn(async (capability: VaultUseCapability, binding: CredentialUseBinding): Promise<CredentialUseResult> => {
      lease = execution.authority.claimCredentialSink(capability, binding);
      usedBinding = binding;
      return { status: 'submitted_unconfirmed' as const, retry: false as const, retainIsolatedLogin: true };
    }) };
  const execution = createCredentialExecution(host, portAvailable ? port : undefined, lifetime.signal);
  return { execution, target, port, host, person, lifetime, revoked, guard,
    changePolicy: () => { generation = randomUUID(); }, lease: () => lease, binding: () => usedBinding };
}

describe('fixed password execution permission integration', () => {
  it.each(['pending', 'rejected'] as const)('refuses %s registration before invoking or claiming the fixed sink', async mode => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    let completed = 0, finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.host.registerUse.mockImplementationOnce(() => mode === 'pending'
      ? pending.then(() => { completed++; }) : Promise.reject(new Error('synthetic_registration_rejected')));
    await expect(f.execution.use()).rejects.toThrow('capability_unavailable');
    expect(completed).toBe(0); expect(f.lease()).toBeUndefined();
    expect(f.host.useCredential).not.toHaveBeenCalled();
    if (mode === 'pending') { finish(); await pending; await Promise.resolve(); }
    await expect(f.execution.use()).rejects.toThrow();
    expect(f.lease()).toBeUndefined(); expect(f.host.useCredential).not.toHaveBeenCalled();
  });

  it('allows the fixed sink only after the synchronous registration positive control completes', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    let completed = 0;
    f.host.registerUse.mockImplementationOnce(() => { completed++; });
    await f.execution.use();
    expect(completed).toBe(1); expect(f.host.useCredential).toHaveBeenCalledOnce();
    expect(f.lease()).toBeDefined();
  });

  it('keeps missing permission unavailable before requesting approval or releasing a buffer', async () => {
    const f = fixture(false);
    await expect(f.execution.request(f.target, 'operation')).rejects.toThrow('credential_permission_unavailable');
    expect(f.host.verifyLocalDecision).not.toHaveBeenCalled();
    expect(f.host.registerUse).not.toHaveBeenCalled(); expect(f.host.useCredential).not.toHaveBeenCalled();
  });

  it('checks the unnumbered request target, keeps duplicate requests idempotent, then binds use identity', async () => {
    const f = fixture();
    const request = await f.execution.request(f.target, 'operation');
    expect(await f.execution.request({ ...f.target }, 'operation')).toEqual(request);
    expect(vi.mocked(f.port.revalidate).mock.calls[0][0]).toEqual({ stage: 'request', target: f.target });
    expect(vi.mocked(f.port.revalidate).mock.calls[0][0].target).not.toHaveProperty('requestId');
    expect(f.execution.decide('allow_once', f.person).status).toBe('approved');
    await f.execution.use();
    expect(vi.mocked(f.port.revalidate).mock.calls.at(-1)?.[0]).toEqual({ stage: 'before_fill',
      target: { ...f.target, requestId: request.requestId, useId: request.useId } });
    expect(f.host.registerUse).toHaveBeenCalledOnce(); expect(f.host.useCredential).toHaveBeenCalledOnce();
  });

  it('does not accept model confirmation or treat permission eligibility as approval', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation');
    expect(() => f.execution.decide('allow_once', { confirmed: true })).toThrow('owner_verification_required');
    await expect(f.execution.use()).rejects.toThrow('not_approved');
    expect(f.host.registerUse).not.toHaveBeenCalled(); expect(f.host.useCredential).not.toHaveBeenCalled();
  });

  it('does not issue or claim after a policy change during the awaited fill check', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    let finish!: (value: PasswordPermissionGuard) => void;
    vi.mocked(f.port.revalidate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const using = f.execution.use(); f.changePolicy(); finish(f.guard());
    await expect(using).rejects.toThrow('credential_permission_unavailable');
    expect(f.host.registerUse).not.toHaveBeenCalled(); expect(f.host.useCredential).not.toHaveBeenCalled();
  });

  it('refuses late successful reads after lifetime revocation', async () => {
    const f = fixture(); let finish!: (value: PasswordPermissionGuard) => void;
    vi.mocked(f.port.revalidate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const requesting = f.execution.request(f.target, 'operation');
    f.lifetime.abort(); finish(f.guard());
    await expect(requesting).rejects.toThrow('credential_permission_unavailable');
    expect(f.host.registerUse).not.toHaveBeenCalled(); expect(f.host.useCredential).not.toHaveBeenCalled();
  });

  it('revokes the existing claimed use synchronously when permission facts abort', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    await f.execution.use(); const lease = f.lease()!;
    f.revoked.abort();
    expect(lease.signal.aborted).toBe(true); expect(lease.revokedSignal.aborted).toBe(true);
    expect(() => lease.assertCurrent()).toThrow();
  });

  it('does not confuse intentional secret cleanup with permission revocation for handback', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    await f.execution.use(); await f.execution.authority.cleanup(f.binding()!.useId);
    expect(f.lease()!.signal.aborted).toBe(true);
    expect(f.lease()!.revokedSignal.aborted).toBe(false);
    expect(f.execution.permission.signal.aborted).toBe(false);
    expect(() => f.execution.permission.assertCurrent(f.binding()!)).not.toThrow();
    await expect(f.execution.permission.revalidate({ stage: 'before_handoff', target: f.binding()! })).resolves.toBeUndefined();
    f.revoked.abort();
    expect(f.lease()!.revokedSignal.aborted).toBe(true);
    expect(() => f.execution.permission.assertCurrent(f.binding()!)).toThrow();
  });

  it('treats an unknown sink error as uncertain, revokes and cleans without replay or raw error output', async () => {
    const f = fixture(); await f.execution.request(f.target, 'operation'); f.execution.decide('allow_once', f.person);
    const value = randomUUID(); f.host.useCredential.mockRejectedValueOnce(new Error(value));
    const result = await f.execution.use();
    expect(result).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(f.host.cleanup).toHaveBeenCalledOnce();
    await expect(f.execution.use()).rejects.toThrow();
    expect(f.host.useCredential).toHaveBeenCalledOnce();
  });
});
