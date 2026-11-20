import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compareCreditAmounts, type CreditAmount } from '@gugu/core/billing/creditAmount'
import { useSpendingPower } from '../../../lib/billing/useSpendingPower'
import { replicaAccount, useReplica } from '../../../lib/replica'
import { useSelect, type Readable } from '../../../lib/selectStore'
import { getRendererSession } from '../../../lib/sessionPublication'
import type { AccountClosureV2FlowState } from '../../../platform/accountClosureV2Flow'
import { accountClosurePolicy } from './accountClosurePolicy'
import { accountClosureV2Controller } from './accountClosureV2Runtime'
import { PersonalAccountDeletion, PersonalAccountDeletionEntry } from './PersonalAccountDeletion'
import type { AccountDeletionView } from './accountDeletionView'

const empty: AccountClosureV2FlowState = { policy: { status: 'unread' }, operation: null, busy: false, error: null }
const noController: Readable<AccountClosureV2FlowState> = { get: () => empty, subscribe: () => () => {} }
const whole = (state: AccountClosureV2FlowState) => state
const terminal = ['processing', 'deleted', 'local-complete', 'finalized', 'cancelled']

/** A remaining balance the dialog can state: read, a valid amount, not negative. null is unknown, never zero. */
function stated(balance: CreditAmount | null): CreditAmount | null {
  try { return balance !== null && compareCreditAmounts(balance, 0) >= 0 ? balance : null } catch { return null }
}

export function AccountDeletionSettings({ ownerId }: { ownerId: string }) {
  const controller = accountClosureV2Controller()
  // The native-led flow publishes one snapshot per change (the operation, busy); admission is read below.
  const state = useSelect(controller ? { get: controller.getSnapshot, subscribe: controller.subscribe } : noController, whole, Object.is)
  const { t } = useTranslation('settings'), { t: tMain } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState(''), [waived, setWaived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent, setIntent] = useState<'sending' | 'confirming' | 'cancelling' | null>(null)
  const policyReading = useReplica(accountClosurePolicy, controller && replicaAccount().id === ownerId ? [] : null)
  // A refresh that failed keeps no earlier admission: closed unless this read says open.
  const available = policyReading.state === 'value' && !policyReading.error && policyReading.value.available
  const operation = state.operation
  // Credits matter only to a fresh closure; an original operation is recovered or cancelled without them.
  const freshClosure = open && available && !operation?.recoveryOnly && !(operation && terminal.includes(operation.phase))
  const spending = useSpendingPower(freshClosure ? { id: ownerId } : null)
  const balance = spending.state === 'value' ? stated(spending.balance) : null
  const readingBalance = freshClosure && spending.state === 'unknown'
  const balanceFailed = freshClosure && spending.state !== 'unknown' && balance === null

  const originalOwner = () => {
    const nativeOwner = controller?.getSnapshot().operation?.ownerId
    if (getRendererSession()?.user.id !== ownerId || nativeOwner && nativeOwner !== ownerId) {
      throw Object.assign(new Error('Current account changed'), { code: 'wrong_local_owner' })
    }
  }
  const act = async (next: typeof intent, work: () => Promise<unknown>) => {
    setError(null); setIntent(next)
    try { originalOwner(); await work() }
    catch (failure) { setError(typeof (failure as { code?: unknown } | null)?.code === 'string' ? (failure as { code: string }).code : 'closure_unavailable') }
    finally { setIntent(null) }
  }
  const show = () => {
    setOpen(true); setError(null); setCode(''); setWaived(false)
    // Opening reads admission again through native; the dialog follows that reading.
    void accountClosurePolicy.refresh()
  }
  if (!controller) return null
  const hasOriginalOperation = operation?.ownerId === ownerId && getRendererSession()?.user.id === ownerId
    && !['finalized', 'cancelled'].includes(operation.phase)
  const pending = operation?.recoveryOnly || operation?.phase === 'confirming' || operation?.phase === 'processing'
  const localPending = operation && ['deleted', 'local-complete'].includes(operation.phase)
  const errorCode = error ?? state.error ?? (balanceFailed ? 'closure_unavailable' : null)
  const beforeConfirmation = !!operation?.pendingEffect && operation.pendingEffect !== 'confirm'
  const policyLoading = policyReading.state === 'unknown'
  const policyUnavailable = !policyLoading && !available
  const phase: AccountDeletionView['phase'] = state.busy ? intent ?? 'loading'
    : localPending ? 'local-pending' : pending ? 'unconfirmed' : policyLoading || readingBalance ? 'loading' : policyUnavailable ? 'unavailable' : 'ready'
  const canCancel = !state.busy && !operation?.confirmCancellationBlocked
    && (!operation || !['processing', 'deleted', 'local-complete', 'finalized'].includes(operation.phase))
  const view: AccountDeletionView = {
    phase, remainingCredits: balance, code, codeSent: !!operation && ['challenge', 'local-prepared', 'prepared'].includes(operation.phase), waived,
    canCancel: !!canCancel, unknownBeforeConfirmation: beforeConfirmation,
    error: errorCode || policyUnavailable ? errorCode === 'verification_failed' ? tMain('auth.otpInvalid')
      : errorCode === 'unauthorized' ? tMain('auth.notSignedIn')
        : errorCode === 'rate_limited' ? tMain('auth.rateLimited')
          : errorCode === 'wrong_local_owner' || errorCode === 'scope_conflict' ? t('iosCalendar.ownerChanged')
            : pending ? t(beforeConfirmation ? 'accountDeletion.phoneRetryUnavailable' : 'accountDeletion.closeResultUnknown')
              : policyUnavailable ? t('accountDeletion.unavailable') : tMain('auth.failed') : undefined,
    onCode: setCode, onWaive: setWaived,
    onResend: () => { void act('sending', () => controller.sendCode()) },
    onDelete: () => { void act('confirming', async () => {
      await controller.confirm({ code, acknowledgeForfeit: true })
      await controller.recoverOriginal()
    }) },
    onCheckResult: () => { void act(null, () => controller.recoverOriginal()) },
    onRetryLocal: () => { void act(null, () => controller.recoverOriginal()) },
  }
  const cancel = () => {
    if (!canCancel) return
    if (!operation || operation.phase === 'cancelled') { setOpen(false); return }
    void act('cancelling', async () => {
      await controller.cancel()
      if (controller.getSnapshot().operation?.phase === 'cancelled') setOpen(false)
    })
  }
  return <>
    <PersonalAccountDeletionEntry available={available} personal={available} hasOriginalOperation={hasOriginalOperation} onOpen={show} />
    {open && <PersonalAccountDeletion view={view} onCancel={cancel} />}
  </>
}
