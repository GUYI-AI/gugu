/** Private host/preload protocol. Never exposed by contextBridge, MCP or the browser registry. */
export const VAULT_LOGIN_CHANNEL = 'gugu:vault-private-login';
export const VAULT_LOGIN_WORLD = 999;
export const VAULT_LOGIN_BRIDGE = '__guguVaultPrivateLogin';

export type VaultLoginSelection = Readonly<{ form: string; account: string; password: string; submitter?: string }>;
export type VaultLoginReview = Readonly<{ documentId: string; formFingerprint: string; destination: string }>;
export type VaultLoginCompletion = Readonly<{
  loginSurfaceId: string; loginSurfaceEpoch: string; surfaceEpoch: string; documentId: string; documentEpoch: string;
  topDocumentChanged: boolean; filledPasswordFieldsAbsent: boolean; requiresPersonInteraction: boolean;
}>;
export type VaultLoginGateRequest = Readonly<{
  nonce: string; phase: 'fill' | 'submit' | 'person-submit'; documentId: string; formFingerprint: string; destination: string;
}>;
export type VaultLoginGateAnswer = { ok: false } | { ok: true; account?: string; password?: string };

export class VaultBrowserLoginError extends Error {
  constructor() { super('credential_login_unavailable'); }
}
