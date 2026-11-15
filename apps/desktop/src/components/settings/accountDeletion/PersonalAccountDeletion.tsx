import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '../SettingsPrimitives'
import { accountDeletionConfirmed, type AccountDeletionImpact, type AccountDeletionView } from './accountDeletionView'
import '../../../i18n/registerSettingsCatalog'
import './account-deletion.css'

/** Controlled view: deliberately has no data/network adapter until the owner approves integration. */
export function PersonalAccountDeletion({ view, onCancel }: { view: AccountDeletionView; onCancel: () => void }) {
  const { t, i18n } = useTranslation('settings')
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(value)
  const title = (key: string) => <h2 className="gg-account-deletion-title">{t(`accountDeletion.${key}`)}</h2>
  const actions = (primary: ReactNode, cancelLabel = 'cancel') => <div className="gg-settings-actions">
    <Button variant="ghost" onClick={onCancel} disabled={'busy' in view && view.busy}>{t(`accountDeletion.${cancelLabel}`)}</Button>{primary}
  </div>
  function consequences(impact: AccountDeletionImpact) {
    return <SettingsGroup presentation="summary">
      <SettingsRow title={t('accountDeletion.agents')} description={t('accountDeletion.agentsNote')} control={number(impact.agents)} />
      <SettingsRow title={t('accountDeletion.projects')} description={t('accountDeletion.projectsNote')} control={number(impact.projects)} />
      <SettingsRow title={t('accountDeletion.files')} description={t('accountDeletion.filesNote')} control={<span>{number(impact.files)} <span>{formatAttachmentSize(impact.fileBytes)}</span></span>} />
      <SettingsRow title={t('accountDeletion.orders')} />
      <SettingsRow title={t('accountDeletion.messages')} description={t('accountDeletion.messagesNote')} control={number(impact.groupMessages)} />
      <SettingsRow title={t('accountDeletion.credits')} description={t('accountDeletion.creditsNote')} control={number(impact.remainingCredits)} />
    </SettingsGroup>
  }
  if (view.stage === 'loading') return <SettingsPage><SettingsNote role="status">{t('accountDeletion.loading')}</SettingsNote></SettingsPage>
  if (view.stage === 'unavailable') return <SettingsPage>
    {title('unavailable')}<SettingsNote role="alert">{t('accountDeletion.unavailableNote')}</SettingsNote>
    {actions(<Button onClick={view.onRetry}>{t('accountDeletion.retry')}</Button>)}
  </SettingsPage>
  if (view.stage === 'blocked') return <SettingsPage>
    {title('blocked')}<SettingsNote>{view.reason}</SettingsNote>
    <SettingsGroup presentation="summary">{view.items.map(item => <SettingsRow key={item.id} title={item.label}
      control={item.onAction && item.actionLabel ? <Button onClick={item.onAction}>{item.actionLabel}</Button> : undefined} />)}</SettingsGroup>
    <SettingsNote>{t('accountDeletion.notDeleted')}</SettingsNote>
    {actions(<Button onClick={view.onRetry}>{t('accountDeletion.retry')}</Button>)}
  </SettingsPage>
  if (view.stage === 'deleted') return <SettingsPage>
    {title('deleted')}<SettingsNote>{t('accountDeletion.deletedNote')}</SettingsNote>
    <SettingsNote>{t('accountDeletion.creditsWaived', { amount: number(view.waivedCredits) })}</SettingsNote>
    <SettingsNote>{t('accountDeletion.messagesNote')}</SettingsNote>
    <div className="gg-settings-actions"><Button variant="primary" onClick={view.onReturnToLogin}>{t('accountDeletion.returnLogin')}</Button></div>
  </SettingsPage>
  if (view.stage === 'impact') return <SettingsPage>
    {title('impact')}<SettingsNote>{t('accountDeletion.impactNote')}</SettingsNote>
    {consequences(view.impact)}<SettingsNote>{t('accountDeletion.dataPolicy')}</SettingsNote><SettingsNote>{t('accountDeletion.irreversible')}</SettingsNote>
    <SettingsNote>{t('accountDeletion.subscriptionNote')}</SettingsNote>
    <label className="gg-account-deletion-consent"><input type="checkbox" checked={view.acknowledged} onChange={event => view.onAcknowledge(event.target.checked)} />{t('accountDeletion.acknowledge')}</label>
    {actions(<Button variant="primary" disabled={!view.acknowledged} onClick={view.onContinue}>{t('accountDeletion.continue')}</Button>)}
  </SettingsPage>
  if (view.stage === 'verify') return <SettingsPage>
    {title('verify')}<SettingsNote>{t('accountDeletion.verifyNote', { email: view.email })}</SettingsNote>
    <form className="gg-account-deletion-form" onSubmit={event => { event.preventDefault(); if (!view.busy && /^\d{6}$/.test(view.code)) view.onVerify() }}>
      <Field.Root invalid={!!view.error}><Field.Label>{t('accountDeletion.code')}</Field.Label><Field.Input value={view.code} onValueChange={value => view.onCode(value.replace(/\D/g, ''))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={view.busy} />{view.error && <Field.Error match>{view.error}</Field.Error>}</Field.Root>
      <Button variant="ghost" disabled={view.busy} onClick={view.onResend}>{t('accountDeletion.resend')}</Button>
      {actions(<Button type="submit" variant="primary" disabled={view.busy || !/^\d{6}$/.test(view.code)}>{t('accountDeletion.verifyContinue')}</Button>)}
    </form>
  </SettingsPage>
  const allowed = accountDeletionConfirmed(view.confirmation, view.impact.remainingCredits, view.waived) && !view.busy
  return <SettingsPage>
    {title('confirm')}<SettingsNote>{view.impact.email}</SettingsNote><SettingsNote>{t('accountDeletion.irreversible')}</SettingsNote>
    {consequences(view.impact)}<SettingsNote>{t('accountDeletion.dataPolicy')}</SettingsNote>
    <form className="gg-account-deletion-form" onSubmit={event => { event.preventDefault(); if (allowed) view.onDelete() }}>
      {view.impact.remainingCredits > 0 && <label className="gg-account-deletion-consent"><input type="checkbox" checked={view.waived} onChange={event => view.onWaive(event.target.checked)} disabled={view.busy} />{t('accountDeletion.waive', { amount: number(view.impact.remainingCredits) })}</label>}
      <Field.Root invalid={!!view.error}><Field.Label>{t('accountDeletion.confirmPhrase')}</Field.Label><Field.Input value={view.confirmation} onValueChange={view.onConfirmation} autoComplete="off" disabled={view.busy} />{view.error && <Field.Error match>{view.error}</Field.Error>}</Field.Root>
      {view.busy && <SettingsNote role="status">{t('accountDeletion.deleting')}</SettingsNote>}
      {actions(<Button type="submit" variant="danger" disabled={!allowed}>{t('accountDeletion.deletePermanently')}</Button>, 'keep')}
    </form>
  </SettingsPage>
}

/** Demo-ready entry only; the live Settings screen is deliberately not wired to it. */
export function PersonalAccountDeletionEntry({ available, personal, onOpen }: { available: boolean; personal: boolean; onOpen: () => void }) {
  const { t } = useTranslation('settings')
  if (!available || !personal) return null
  return <SettingsRow title={t('accountDeletion.entry')} description={t('accountDeletion.entryNote')}
    control={<Button variant="ghost" onClick={onOpen}>{t('accountDeletion.entry')}</Button>} />
}
