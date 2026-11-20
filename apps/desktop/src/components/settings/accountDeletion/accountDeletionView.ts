import { compareCreditAmounts, requireCreditAmount, type CreditAmount } from '@gugu/core/billing/creditAmount'

export type AccountDeletionPhase = 'loading' | 'unavailable' | 'ready' | 'sending' | 'preparing' | 'confirming' | 'unconfirmed' | 'local-pending' | 'cancelling'
export interface AccountDeletionView {
  phase: AccountDeletionPhase
  /** null is unread/unavailable, never a zero-credit account. */
  remainingCredits: CreditAmount | null
  code: string
  codeSent: boolean
  waived: boolean
  /** The same Cancel control fences unknown confirmation only while native permits it. */
  canCancel?: boolean
  unknownBeforeConfirmation?: boolean
  error?: string
  onCode(value: string): void
  onWaive(value: boolean): void
  onResend(): void
  onDelete(): void
  onCheckResult(): void
  onRetryLocal(): void
}

/** The final button itself is confirmation; the approved dialog has no typed phrase. */
export function accountDeletionCanSubmit(view: Pick<AccountDeletionView, 'phase' | 'remainingCredits' | 'code' | 'codeSent' | 'waived'>): boolean {
  if (view.phase !== 'ready' || !view.codeSent || !/^\d{6}$/.test(view.code) || view.remainingCredits === null) return false
  try {
    requireCreditAmount(view.remainingCredits, 'account-closure.remaining-credits')
    return compareCreditAmounts(view.remainingCredits, 0) >= 0 && (compareCreditAmounts(view.remainingCredits, 0) === 0 || view.waived)
  } catch { return false }
}
