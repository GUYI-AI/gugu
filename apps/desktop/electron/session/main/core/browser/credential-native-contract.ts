import type { GuguMcpContext } from '../../../../acp-engine-utils';
import type { CredentialReference, Invalidation, VaultBrowserSink } from '../../../../password-vault/contracts';
import type { LocalPasswordVault } from '../../../../password-vault/service';
import type { PasswordPermissionPort, PasswordPermissionTarget } from '../../../../permissions/password-execution';
import type { CredentialArtifactCleanup } from './credential-cleanup';
import type { CredentialUseBinding } from './credential-use-contract';
import type { VaultLoginSelection } from './vault-browser-login-protocol';

/** Supplied by the native session/grant creator, never reconstructed from tool arguments or grantKey.
 * The fixed host must check the original authenticated account/session/installation/device lifetime.
 */
export interface CredentialNativeContext {
  readonly context: GuguMcpContext;
  readonly sessionId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

/** Untrusted request data contains no approval, caller identity or protection readiness. */
export type CredentialNativeRequest = Readonly<{
  operationId: string;
  browserId: string;
  reference: CredentialReference;
  loginUrl: string;
  selection: VaultLoginSelection;
}>;

/** Metadata only, resolved inside the same fixed vault host; never a password/account export. */
export type CredentialNativeReference = Readonly<{
  reference: CredentialReference;
  origin: string;
  partition: string;
  assertCurrent(): void;
  signal: AbortSignal;
}>;

/** Fixed account/installation constructor ports. None is accepted per tool call.
 * Missing real actor/readiness/person/custodian evidence must keep the factory unavailable.
 */
export interface CredentialNativeFactoryHost {
  readonly ownerId: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly lifetime: AbortSignal;
  /** Same LocalPasswordVault instance is used for use, metadata and outcomeAudit. */
  createVault(browser: VaultBrowserSink, invalidate: (event: Invalidation) => Promise<void>): LocalPasswordVault;
  resolveReference(context: CredentialNativeContext, reference: CredentialReference,
    signal: AbortSignal): Promise<CredentialNativeReference>;
  /** Reader adapter resolves actual browser/surface ownership through the captured native getter. */
  createPermission(context: CredentialNativeContext,
    target: () => PasswordPermissionTarget | CredentialUseBinding): Promise<PasswordPermissionPort>;
  /** Every class is backed by the real writer and its drain; no unconditional clean adapter. */
  createArtifacts(binding: CredentialUseBinding): CredentialArtifactCleanup;
  verifyLocalDecision(binding: CredentialUseBinding, evidence: unknown): boolean;
  verifyLocalContinue(binding: CredentialUseBinding, evidence: unknown): boolean;
}
