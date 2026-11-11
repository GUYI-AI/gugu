/** Trusted desktop UI protocol. Never register these methods as Agent tools. */
export interface PasswordReference { id: string; version: number; epoch: string }
export interface PasswordGrant { subject: string; level: 'read' | 'write' }
export interface PasswordItem { reference: PasswordReference; origin: string; maskedAccount: string; fields: { id: string; name: string }[]; grants: PasswordGrant[] }
export interface PasswordField { id: string; name: string; value: string }
/** Plaintext for the person only, after local verification; never part of a snapshot. */
export interface PasswordSecrets { account: string; password: string; fields: PasswordField[] }
export interface PasswordApproval { kind?: 'login'; requestId: string; origin: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount: string; expiresAt: number }
/** An Agent asking the person to save a new credential, or to change one it may not write. Metadata only. */
export interface PasswordSaveRequest { kind: 'save'; requestId: string; origin: string; credentialId?: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount?: string; expiresAt: number }
export type PasswordRequestView = PasswordApproval | PasswordSaveRequest
/** What the Agent proposed. Shown only in the person's own add/edit form, never in a message. */
export interface PasswordSaveDraft { origin: string; account: string; password: string; fields: PasswordField[]; credentialId?: string; agentName: string }
export const PASSWORD_REQUEST_PREFIX = 'gugu-password-request-v1\n'
export interface PasswordGrantCandidate { subject: string; name: string; kind: 'agent' | 'project'; project?: string }
/** Cross-device sync (#2481). joining: this device waits for approval on another device, `code` once both sides are
 * ready · blocked: this device joined before with a key it no longer has · ready: the account's devices and requests. */
export interface PasswordSyncDevice { deviceId: string; label: string; platform: string; current: boolean }
export interface PasswordSyncRequest extends PasswordSyncDevice { stage: 'new' | 'elsewhere' | 'waiting' | 'compare' | 'mismatch'; code?: string }
export type PasswordSyncView = { state: 'off' } | { state: 'joining'; code?: string; recovery?: boolean } | { state: 'blocked'; recovery?: boolean }
  | { state: 'refused'; recovery?: boolean }
  | { state: 'ready'; devices: PasswordSyncDevice[]; requests: PasswordSyncRequest[]; recovery: 'set' | 'unset' | 'ask' }
export interface PasswordSnapshot { items: PasswordItem[]; approvals: PasswordApproval[]; saves: PasswordSaveRequest[]; candidates: PasswordGrantCandidate[]; sync?: PasswordSyncView }
export type PasswordUiCommand =
  | { type: 'snapshot' }
  /** Without reference: add. With reference: edit, where blank account/password/field values keep the stored value.
   * With requestId: the person completes that Agent's save request. */
  | { type: 'save'; origin: string; account: string; password: string; fields: PasswordField[]; reference?: PasswordReference; requestId?: string }
  | { type: 'delete'; reference: PasswordReference }
  | { type: 'reveal'; reference: PasswordReference }
  | { type: 'grants'; reference: PasswordReference; grants: PasswordGrant[] }
  | { type: 'decide'; requestId: string; decision: 'allow_once' | 'reject' }
  | { type: 'save-draft'; requestId: string }
  | { type: 'reject-save'; requestId: string }
  /** Another device asks to join (the app opens it on the machine the person is at): allow after comparing the
   * digits, or refuse. Removing a device is Settings → 设备, which re-keys. */
  | { type: 'sync-approve'; deviceId: string }
  | { type: 'sync-reject'; deviceId: string }
  /** This device was refused, and the person asks again (with a new device key). */
  | { type: 'sync-ask-again' }
  /** Recovery code (a device on paper): generate or replace it, drop it, decline the offer, or join with it. Generating
   * and recovering answer with `recoveryCode`, shown once. */
  | { type: 'sync-recovery-create' }
  | { type: 'sync-recovery-remove' }
  | { type: 'sync-recovery-skip' }
  | { type: 'sync-recover'; code: string }
export type PasswordUiReply = { ok: true; snapshot: PasswordSnapshot; secrets?: PasswordSecrets; draft?: PasswordSaveDraft; recoveryCode?: string }
  | { ok: false; code: string }
export interface PasswordBetaUi { invoke(command: PasswordUiCommand): Promise<PasswordUiReply>; subscribe(listener: () => void): () => void }

/** 「去填写」 in a chat card hands one save request to Settings → 密码, which may not be mounted yet. */
export const PASSWORD_FILL_EVENT = 'gugu:password-fill'
const FILL_KEY = '__guguPasswordFill'
export function requestPasswordFill(requestId: string): void {
  (globalThis as Record<string, unknown>)[FILL_KEY] = requestId
  globalThis.dispatchEvent?.(new Event(PASSWORD_FILL_EVENT))
}
export function takePasswordFill(): string | undefined {
  const scope = globalThis as Record<string, unknown>, value = scope[FILL_KEY]
  delete scope[FILL_KEY]
  return typeof value === 'string' ? value : undefined
}
/** The strongest level any of the caller's subjects (its Agent, its project) holds on a credential. */
export function passwordGrantLevel(grants: readonly PasswordGrant[], subjects: readonly string[]): 'read' | 'write' | undefined {
  let level: 'read' | 'write' | undefined
  for (const grant of grants) if (subjects.includes(grant.subject)) level = level === 'write' ? 'write' : grant.level
  return level
}
