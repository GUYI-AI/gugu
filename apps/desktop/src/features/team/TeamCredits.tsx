import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { useTeamApi } from './context'
import { teamErrorCopy } from './copy'
import { TeamCheckbox, TeamDialog } from './TeamPrimitives'
import { parseTeamCap, useTeamCommandKey } from './operations'
import { TeamApiError } from './errors'
import type { TeamMemberUsage } from './types'

export type CapTarget = TeamMemberUsage & { name: string }

export function CapDialog({ targets, onClose, onSaved }: { targets: CapTarget[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const initial = targets.length === 1 ? targets[0].cap_credits : null
  const [unlimited, setUnlimited] = useState(initial === null), [amount, setAmount] = useState(initial ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  async function save() {
    let cap
    try { cap = parseTeamCap(amount, unlimited) } catch { setError(t('capInvalid')); return }
    const members = targets.map(target => ({ member_id: target.member_id, cap_credits: cap, expected_revision: target.cap_revision }))
    setBusy(true); setError('')
    try { await api.setCaps(members, key(members)); await onSaved(); onClose() }
    catch (cause) {
      setError(teamErrorCopy(cause, t))
      if (cause instanceof TeamApiError && cause.code === 'version_conflict') { setStale(true); await onSaved() }
    }
    finally { setBusy(false) }
  }
  return <TeamDialog title={targets.length === 1 ? t('setCapFor', { name: targets[0].name }) : t('bulkCap')}
    onClose={() => { if (!busy) onClose() }} actions={<>
      <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      {!stale && <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('save')}</Button>}
    </>}>
    <p>{targets.length === 1 ? t('capCurrent', { name: targets[0].name, credits: formatCredits(targets[0].used_credits) }) : t('capBulkHint', { count: targets.length })}</p>
    <div className="gg-team-checkbox-label"><TeamCheckbox checked={unlimited} onChange={setUnlimited} label={t('noCapSetting')} disabled={busy} /><span>{t('noCapSetting')}</span></div>
    <Field.Root disabled={busy || unlimited}><Field.Label>{t('capAmount')}</Field.Label>
      <Field.Input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy || unlimited} />
      <Field.Description>{t('capHint')}</Field.Description></Field.Root>
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}
