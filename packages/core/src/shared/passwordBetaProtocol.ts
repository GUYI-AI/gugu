/** Trusted desktop UI protocol. Never register these methods as Agent tools. */
export interface PasswordReference { id: string; version: number; epoch: string }
export interface PasswordItem { reference: PasswordReference; origin: string; maskedAccount: string }
export interface PasswordApproval { requestId: string; origin: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount: string; expiresAt: number }
export const PASSWORD_REQUEST_PREFIX = 'gugu-password-request-v1\n'
export interface PasswordSnapshot { status: 'locked' | 'unlocked' | 'unavailable'; initialized: boolean; denied: boolean; items: PasswordItem[]; approvals: PasswordApproval[] }
export type PasswordUiCommand =
  | { type: 'snapshot' | 'unlock' | 'lock' | 'begin-setup' }
  | { type: 'confirm-setup'; setupId: string; material: string }
  | { type: 'save'; origin: string; account: string; password: string }
  | { type: 'delete'; reference: PasswordReference }
  | { type: 'deny'; value: boolean }
  | { type: 'decide'; requestId: string; decision: 'allow_once' | 'reject' }
export type PasswordUiReply = { ok: true; snapshot: PasswordSnapshot; setup?: { setupId: string; recoveryMaterial: string } }
  | { ok: false; code: string }
export interface PasswordBetaUi { invoke(command: PasswordUiCommand): Promise<PasswordUiReply>; subscribe(listener: () => void): () => void }
