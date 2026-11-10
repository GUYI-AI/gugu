/** Trusted desktop UI protocol. Never register these methods as Agent tools. */
export interface PasswordReference { id: string; version: number; epoch: string }
export interface PasswordGrant { subject: string; level: 'read' | 'write' }
export interface PasswordItem { reference: PasswordReference; origin: string; maskedAccount: string; fields: { id: string; name: string }[]; grants: PasswordGrant[] }
export interface PasswordField { id: string; name: string; value: string }
/** Plaintext for the person only, after local verification; never part of a snapshot. */
export interface PasswordSecrets { account: string; password: string; fields: PasswordField[] }
export interface PasswordApproval { requestId: string; origin: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount: string; expiresAt: number }
export const PASSWORD_REQUEST_PREFIX = 'gugu-password-request-v1\n'
export interface PasswordGrantCandidate { subject: string; name: string; kind: 'agent' | 'project'; project?: string }
export interface PasswordSnapshot { items: PasswordItem[]; approvals: PasswordApproval[]; candidates: PasswordGrantCandidate[] }
export type PasswordUiCommand =
  | { type: 'snapshot' }
  /** Without reference: add. With reference: edit, where blank account/password/field values keep the stored value. */
  | { type: 'save'; origin: string; account: string; password: string; fields: PasswordField[]; reference?: PasswordReference }
  | { type: 'delete'; reference: PasswordReference }
  | { type: 'reveal'; reference: PasswordReference }
  | { type: 'grants'; reference: PasswordReference; grants: PasswordGrant[] }
  | { type: 'decide'; requestId: string; decision: 'allow_once' | 'reject' }
export type PasswordUiReply = { ok: true; snapshot: PasswordSnapshot; secrets?: PasswordSecrets }
  | { ok: false; code: string }
export interface PasswordBetaUi { invoke(command: PasswordUiCommand): Promise<PasswordUiReply>; subscribe(listener: () => void): () => void }
