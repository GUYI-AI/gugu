import { anySignal } from '@gugu/core/shared/anySignal';
import type { PasswordPermissionPort, PasswordPermissionTarget } from '../../../../permissions/password-execution';
import type { CredentialUseResult } from '../../../../password-vault/contracts';
import { CredentialApprovalState } from './credential-approval-state';
import { CredentialUseAuthorityBridge } from './credential-use-authority';
import { CredentialPermissionBoundary } from './credential-permission';
import { copyCredentialBinding } from './credential-binding';
import type { CredentialUseBinding, CredentialUseCleanup, VaultUseCapability } from './credential-use-contract';

interface CredentialExecutionHost {
  /** Fixed native actor/reference/target checks; no page/Agent-supplied confirmation. */
  current(binding: CredentialUseBinding): boolean;
  isolationCurrent(binding: CredentialUseBinding): boolean;
  verifyLocalDecision(binding: CredentialUseBinding, evidence: unknown): boolean;
  registerUse(capability: VaultUseCapability, binding: CredentialUseBinding, revoked: AbortSignal): void;
  cleanup(binding: CredentialUseBinding): Promise<CredentialUseCleanup>;
  /** Fixed LocalPasswordVault method, never a per-call secret receiver. */
  useCredential(capability: VaultUseCapability, binding: CredentialUseBinding): Promise<CredentialUseResult>;
}

/** Host-only composition for ONE prepared login attempt. No production/IPC/MCP factory is registered.
 * The host must use the returned permission checks in its private surface and handback adapters.
 * Native surface/partition/real custodians/person-entry construction remains the integrator's job.
 */
export function createCredentialExecution(host: CredentialExecutionHost, port: PasswordPermissionPort | undefined,
  lifetime: AbortSignal) {
  const fixed = Object.freeze({ current: host.current.bind(host), isolationCurrent: host.isolationCurrent.bind(host),
    verifyLocalDecision: host.verifyLocalDecision.bind(host), registerUse: host.registerUse.bind(host),
    cleanup: host.cleanup.bind(host), useCredential: host.useCredential.bind(host) });
  const permission = new CredentialPermissionBoundary(port, lifetime);
  const approval = new CredentialApprovalState({ current: binding => {
    permission.assertCurrent(binding); return fixed.current(binding);
  }, verifyLocalDecision: fixed.verifyLocalDecision });
  const authority = new CredentialUseAuthorityBridge({ approval,
    isolationCurrent: binding => { permission.assertCurrent(binding); return fixed.isolationCurrent(binding); },
    registerUse: (capability, binding, revoked) => {
      permission.bindRevocation(revoked);
      // Forward the runtime value so Authority.issue can reject and observe any thenable.
      return fixed.registerUse(capability, binding, anySignal([revoked, permission.signal]));
    },
    cleanup: fixed.cleanup });
  let binding: CredentialUseBinding | undefined;
  let operation: string | undefined;
  const fail = () => new Error('credential_execution_unavailable');
  permission.signal.addEventListener('abort', () => {
    if (binding) authority.invalidate(binding.accountId, 'revoke', binding.credentialId);
  }, { once: true });
  const sinkAuthority = Object.freeze({ claimCredentialSink: authority.claimCredentialSink.bind(authority),
    cleanup: authority.cleanup.bind(authority), invalidate: authority.invalidate.bind(authority) });
  return Object.freeze({ permission, authority: sinkAuthority,
    status: () => { if (!binding) throw fail(); return approval.status(binding.requestId); },
    request: async (target: PasswordPermissionTarget, operationId: string) => {
      if (!operationId || operation !== undefined && operation !== operationId) throw fail();
      operation = operationId;
      // This is the actual awaited request gate, before allocating approval request/use identities.
      await permission.revalidate({ stage: 'request', target });
      permission.assertCurrent(binding ?? target);
      const view = approval.request(target, operationId);
      const next = copyCredentialBinding({ ...target, requestId: view.requestId, useId: view.useId });
      permission.bindUse(next); binding = next;
      return view;
    },
    decide: (decision: 'allow_once' | 'reject', evidence: unknown) => {
      if (!binding) throw fail();
      return approval.decide(binding.requestId, decision, evidence);
    },
    use: async () => {
      if (!binding) throw fail();
      const current = binding;
      // Before authority issuance, fixed sink claim and any vault secret-buffer release.
      await permission.revalidate({ stage: 'before_fill', target: current });
      permission.assertCurrent(current);
      const capability = authority.issue(current.requestId, current);
      permission.assertCurrent(current);
      try {
        const result = await fixed.useCredential(capability, current);
        permission.assertCurrent(current);
        return result;
      }
      catch {
        // A failed/response-lost fixed sink may already have had an effect. Never retry it.
        authority.invalidate(current.accountId, 'revoke', current.credentialId);
        await authority.cleanup(current.useId);
        return { status: 'uncertain' as const, retry: false as const, retainIsolatedLogin: true };
      }
    },
    cancel: () => { if (!binding) throw fail(); return approval.cancel(binding.requestId, binding); },
  });
}
