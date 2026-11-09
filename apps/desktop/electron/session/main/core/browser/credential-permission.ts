import { anySignal } from '@gugu/core/shared/anySignal';
import type { PasswordPermissionCheck, PasswordPermissionGuard, PasswordPermissionPort,
  PasswordPermissionTarget } from '../../../../permissions/password-execution';
import { copyCredentialBinding, credentialBindingMatches } from './credential-binding';
import type { CredentialUseBinding } from './credential-use-contract';

export interface CredentialPermissionChecks {
  readonly signal: AbortSignal;
  revalidate(check: PasswordPermissionCheck): Promise<void>;
  assertCurrent(binding: CredentialUseBinding | PasswordPermissionTarget): void;
}

const targetKeys = ['accountId', 'installationId', 'agentId', 'sessionId', 'browserId', 'loginSurfaceId',
  'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint', 'credentialId', 'credentialVersion',
  'lockEpoch', 'origin', 'operation'] as const;
const unavailable = () => new Error('credential_permission_unavailable');

/** One host-owned execution's eligibility facts, NEVER an approval or submission ledger.
 * The lifetime signal must cover actor/approval/partition revocation. Do not supply the
 * fill lease's cleanup signal: intentional buffer clearing must not revoke handback facts.
 */
export class CredentialPermissionBoundary implements CredentialPermissionChecks {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly read: PasswordPermissionPort['revalidate'] | undefined;
  private readonly guards: Array<Pick<PasswordPermissionGuard, 'signal' | 'assertCurrent'>> = [];
  private target: PasswordPermissionTarget | undefined;
  private binding: CredentialUseBinding | undefined;

  constructor(port: PasswordPermissionPort | undefined, lifetime: AbortSignal) {
    this.read = port?.revalidate.bind(port);
    this.signal = anySignal([lifetime, this.controller.signal]);
  }

  async revalidate(input: PasswordPermissionCheck): Promise<void> {
    try {
      this.signal.throwIfAborted();
      if (!this.read) throw unavailable();
      if (input.stage === 'request') {
        if ('requestId' in input.target || 'useId' in input.target) throw unavailable();
        const target = Object.freeze(Object.fromEntries(targetKeys.map(key => [key, input.target[key]]))) as PasswordPermissionTarget;
        if (!this.target) this.target = target;
        this.assertTarget(target);
      } else {
        this.assertTarget(input.target);
        if (!this.binding || !credentialBindingMatches(this.binding, input.target)) throw unavailable();
      }
      // Retain only copied reviewed fields while the asynchronous readers run.
      const check: PasswordPermissionCheck = input.stage === 'request'
        ? Object.freeze({ stage: 'request', target: this.target! })
        : Object.freeze({ stage: input.stage, target: copyCredentialBinding(input.target) });
      if (this.guards.length) this.assertCurrent(this.binding ?? check.target);
      const result = await this.read(check, this.signal);
      this.signal.throwIfAborted();
      if (!result || result.requiresPersonConfirmation !== true || !(result.signal instanceof AbortSignal)
        || typeof result.assertCurrent !== 'function') throw unavailable();
      const guard = Object.freeze({ signal: result.signal, assertCurrent: result.assertCurrent.bind(result) });
      this.guards.push(guard);
      if (guard.signal.aborted) throw unavailable();
      guard.signal.addEventListener('abort', this.revoke, { once: true, signal: this.signal });
      this.assertCurrent(this.binding ?? check.target);
    } catch {
      this.revoke();
      throw unavailable();
    }
  }

  /** The private approval state supplies these IDs. Strings from tools do not bind a use. */
  bindUse(binding: CredentialUseBinding): void {
    this.assertCurrent(binding);
    if (this.binding && !credentialBindingMatches(this.binding, binding)) { this.revoke(); throw unavailable(); }
    this.binding ??= copyCredentialBinding(binding);
  }

  /** Approval/actor/partition revocation only; never the proof-only cleanup controller. */
  bindRevocation(signal: AbortSignal): void {
    if (!(signal instanceof AbortSignal) || signal.aborted || this.signal.aborted) { this.revoke(); throw unavailable(); }
    signal.addEventListener('abort', this.revoke, { once: true, signal: this.signal });
  }

  assertCurrent(binding: CredentialUseBinding | PasswordPermissionTarget): void {
    try {
      this.signal.throwIfAborted(); this.assertTarget(binding);
      if (!this.guards.length || this.binding && (!('requestId' in binding)
        || !credentialBindingMatches(this.binding, binding))) throw unavailable();
      for (const guard of this.guards) {
        guard.signal.throwIfAborted();
        const result: unknown = guard.assertCurrent();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw unavailable();
        }
        guard.signal.throwIfAborted();
      }
      this.signal.throwIfAborted();
    } catch { this.revoke(); throw unavailable(); }
  }

  private assertTarget(target: PasswordPermissionTarget): void {
    if (!this.target || targetKeys.some(key => target[key] !== this.target![key])) throw unavailable();
  }
  private readonly revoke = () => { this.controller.abort(unavailable()); };
}
