/** View data only. This is not an HTTP/RPC contract; the backend contract is still pending. */
export interface AccountDeletionImpact {
  email: string
  agents: number
  projects: number
  files: number
  fileBytes: number
  groupMessages: number
  remainingCredits: number
}

export const ACCOUNT_DELETION_CONFIRMATION = '注销账号'

/** A UI guard only. The service must independently authorize and reverify every deletion. */
export function accountDeletionConfirmed(confirmation: string, remainingCredits: number, waived: boolean): boolean {
  return confirmation === ACCOUNT_DELETION_CONFIRMATION
    && Number.isFinite(remainingCredits) && remainingCredits >= 0
    && (remainingCredits === 0 || waived)
}

export type AccountDeletionView =
  | { stage: 'loading' }
  | { stage: 'impact'; impact: AccountDeletionImpact; acknowledged: boolean; onAcknowledge: (value: boolean) => void; onContinue: () => void }
  | { stage: 'verify'; email: string; code: string; busy: boolean; error?: string; onCode: (value: string) => void; onVerify: () => void; onResend: () => void }
  | { stage: 'confirm'; impact: AccountDeletionImpact; confirmation: string; waived: boolean; busy: boolean; error?: string; onConfirmation: (value: string) => void; onWaive: (value: boolean) => void; onDelete: () => void }
  | { stage: 'deleted'; waivedCredits: number; onReturnToLogin: () => void }
  | { stage: 'blocked'; reason: string; items: readonly { id: string; label: string; actionLabel?: string; onAction?: () => void }[]; onRetry: () => void }
  | { stage: 'unavailable'; onRetry: () => void }
