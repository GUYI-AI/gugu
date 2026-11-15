/** Trusted desktop UI protocol. Never register these methods as Agent tools. */
export interface PasswordReference { id: string; version: number; epoch: string }
export interface PasswordGrant { subject: string; level: 'read' | 'write' }
/** One credential: a website and named values. Values marked non-secret are included (`account`, a field's `value`);
 * secret ones never are. `sites`: other websites it may be filled into, besides its own. */
export interface PasswordItem { reference: PasswordReference; name: string; origin: string; account?: string; maskedAccount: string; accountSecret: boolean
  hasPassword: boolean; fields: { id: string; name: string; secret: boolean; value?: string }[]; grants: PasswordGrant[]; sites: string[] }
/** `secret` defaults to true. Only the person turns a secret value non-secret. */
export interface PasswordField { id: string; name: string; value: string; secret?: boolean }
/** Plaintext for the person only, after local verification; never part of a snapshot. */
export interface PasswordSecrets { account: string; password: string; fields: PasswordField[] }
/**
 * An Agent asking to fill a saved credential's values into a website. `origin`: where they go. `fields`: which values.
 * `credential`: its name when it is not that website's own. `elsewhere`: the website is neither the credential's own nor
 * one of its sites (the person may remember it). `exposed`: secret values going into ordinary inputs, which a page can
 * show again. Metadata only.
 */
export interface PasswordApproval { kind?: 'login'; requestId: string; origin: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount: string; expiresAt: number
  fields?: string[]; credential?: string; elsewhere?: boolean; exposed?: string[]
  /** Value by value: which one goes into which input of the page (the page's own name for it; `plain`: a secret into an
   * ordinary input). `submit`: the button clicked afterwards, empty when the form is submitted. `always`: 「始终允许」 can be given. */
  fills?: { value: string; key?: string; input: string; secret?: boolean; plain?: boolean
    /** saved: in the vault · given: the Agent already knew it (`given`, never a secret) · missing: the person types it. */
    source?: 'saved' | 'given' | 'missing'; given?: string }[]; submit?: string
  /** The card's 「记住」: `auto` keeps what was typed and lets this Agent fill it next time without asking; `keep` only keeps it. */
  remember?: 'auto' | 'keep'
  /** The credential, so the person's own card can show its non-secret values from the snapshot. */
  credentialId?: string }
/** An Agent asking the person to save a new credential, or to change one it may not write. Metadata only. */
export interface PasswordSaveRequest { kind: 'save'; requestId: string; origin: string; credentialId?: string; agent: string; agentName: string; sessionTitle: string; sessionId: string; deviceId: string; maskedAccount?: string; expiresAt: number
  /** What the card asks the person to fill, in order (names only): `account` / `password`, or a field's id. */
  inputs?: PasswordSaveInput[] }
export interface PasswordSaveInput { key: string; name: string; secret: boolean }
export type PasswordRequestView = PasswordApproval | PasswordSaveRequest
/** What the Agent proposed. Shown only in the person's own add/edit form, never in a message. */
export interface PasswordSaveDraft { origin: string; name?: string; account: string; accountSecret?: boolean; password: string; fields: PasswordField[]; credentialId?: string; agentName: string }
export const PASSWORD_REQUEST_PREFIX = 'gugu-password-request-v1\n'
export interface PasswordGrantCandidate { subject: string; name: string; kind: 'agent' | 'project'; project?: string }
/** Cross-device sync (#2481). joining: this device waits for approval on another device, `code` once both sides are
 * ready · blocked: this device joined before with a key it no longer has · ready: the account's devices and requests. */
export interface PasswordSyncDevice { deviceId: string; label: string; platform: string; current: boolean }
export interface PasswordSyncRequest extends PasswordSyncDevice { stage: 'new' | 'elsewhere' | 'waiting' | 'compare' | 'mismatch'; code?: string }
export type PasswordSyncView = { state: 'off' } | { state: 'joining'; code?: string; recovery?: boolean } | { state: 'blocked'; recovery?: boolean }
  | { state: 'refused'; recovery?: boolean }
  | { state: 'ready'; devices: PasswordSyncDevice[]; requests: PasswordSyncRequest[]; recovery: 'set' | 'unset' | 'ask' }
/**
 * Where an approved card's use is: `running`, then `filled` (the values are in the page) or why not. `keep`: what 「记住」
 * did: `waiting` for the login to go through, `kept` in the vault, or `dropped` (it did not go through).
 */
export interface PasswordFillOutcome { requestId: string; result: string; keep?: 'waiting' | 'kept' | 'dropped' }
export interface PasswordSnapshot { items: PasswordItem[]; approvals: PasswordApproval[]; saves: PasswordSaveRequest[]; candidates: PasswordGrantCandidate[]; sync?: PasswordSyncView
  outcomes?: PasswordFillOutcome[] }
/** A value the person added on a card under a name of theirs, to keep with the credential. */
export interface PasswordExtraValue { name: string; value: string; secret: boolean }
export type PasswordUiCommand =
  | { type: 'snapshot' }
  /** Without reference: add. With reference: edit, where blank account/password/field values keep the stored value.
   * With requestId: the person completes that Agent's save request. */
  | { type: 'save'; origin: string; name?: string; account: string; accountSecret?: boolean; password: string; fields: PasswordField[]; sites?: string[]; reference?: PasswordReference; requestId?: string }
  | { type: 'delete'; reference: PasswordReference }
  | { type: 'reveal'; reference: PasswordReference }
  | { type: 'grants'; reference: PasswordReference; grants: PasswordGrant[] }
  /** allow_always: allow, and from now on this Agent uses this credential on this website without asking. */
  /** typed: what the person typed on the card, by position (blank: the saved or given value). remember: the card's 「记住」. */
  /** `secret`: per value, 保密 or not, as the person marked it for 「存到咕咕」; `extra`: items the person added to keep with them. */
  | { type: 'decide'; requestId: string; decision: 'allow_once' | 'reject'; typed?: string[]; remember?: boolean; secret?: boolean[]; extra?: PasswordExtraValue[] }
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
