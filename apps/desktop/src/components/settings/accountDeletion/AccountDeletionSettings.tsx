import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { requireCreditAmount, compareCreditAmounts, type CreditAmount } from '@gugu/core/billing/creditAmount'
import { getCreditsBalance } from '../../../lib/billing/balance'
import { getRendererSession } from '../../../lib/sessionPublication'
import type { AccountClosureV2FlowState } from '../../../platform/accountClosureV2Flow'
import { accountClosureV2Controller } from './accountClosureV2Runtime'
import { PersonalAccountDeletion, PersonalAccountDeletionEntry } from './PersonalAccountDeletion'
import type { AccountDeletionView } from './accountDeletionView'

const empty: AccountClosureV2FlowState = { policy: { status: 'unread' }, operation: null, busy: false, error: null }
const noSubscription = () => () => {}
const emptySnapshot = () => empty

export function AccountDeletionSettings({ ownerId }: { ownerId: string }) {
  const controller = accountClosureV2Controller()
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const { t } = useTranslation('settings'), { t: tMain } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const [policyOwner, setPolicyOwner] = useState<string | null>(null)
  const [balance, setBalance] = useState<CreditAmount | null>(null)
  const [readingBalance, setReadingBalance] = useState(false)
  const [code, setCode] = useState(''), [waived, setWaived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent, setIntent] = useState<'sending' | 'confirming' | 'cancelling' | null>(null)

  useEffect(() => {
    let live = true, started = false
    setPolicyOwner(null); setOpen(false)
    if (!controller) return
    const read = () => {
      if (started || controller.getSnapshot().busy) return
      started = true
      void controller.refresh().then(() => {
        if (live && getRendererSession()?.user.id === ownerId) setPolicyOwner(ownerId)
      }).catch(() => undefined)
    }
    const unsubscribe = controller.subscribe(read)
    read()
    return () => { live = false; unsubscribe() }
  }, [controller, ownerId])

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
  const show = async () => {
    if (!controller) return
    setOpen(true); setBalance(null); setReadingBalance(true); setError(null); setCode(''); setWaived(false)
    try {
      originalOwner(); await controller.refresh(); originalOwner()
      const refreshed = controller.getSnapshot()
      if (refreshed.policy.status !== 'known' || !refreshed.policy.value.available || refreshed.operation?.recoveryOnly
        || refreshed.operation && ['processing', 'deleted', 'local-complete', 'finalized', 'cancelled'].includes(refreshed.operation.phase)) return
      const value = requireCreditAmount(await getCreditsBalance(), 'account-closure.remaining-credits')
      originalOwner()
      if (compareCreditAmounts(value, 0) < 0) throw new Error('Credit balance unavailable')
      setBalance(value)
    } catch { setError('closure_unavailable') }
    finally { setReadingBalance(false) }
  }
  if (!controller) return null
  const operation = state.operation
  const hasOriginalOperation = operation?.ownerId === ownerId && getRendererSession()?.user.id === ownerId
    && !['finalized', 'cancelled'].includes(operation.phase)
  const pending = operation?.recoveryOnly || operation?.phase === 'confirming' || operation?.phase === 'processing'
  const localPending = operation && ['deleted', 'local-complete'].includes(operation.phase)
  const errorCode = error ?? state.error
  const beforeConfirmation = !!operation?.pendingEffect && operation.pendingEffect !== 'confirm'
  const policyUnavailable = state.policy.status !== 'known' || !state.policy.value.available
  const phase: AccountDeletionView['phase'] = state.busy ? intent ?? 'loading'
    : localPending ? 'local-pending' : pending ? 'unconfirmed' : policyUnavailable ? 'unavailable' : readingBalance ? 'loading' : 'ready'
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
    <PersonalAccountDeletionEntry available={policyOwner === ownerId && state.policy.status === 'known' && state.policy.value.available}
      personal={state.policy.status === 'known' && state.policy.value.available} hasOriginalOperation={hasOriginalOperation}
      onOpen={() => { void show() }} />
    {open && <PersonalAccountDeletion view={view} onCancel={cancel} />}
  </>
}
