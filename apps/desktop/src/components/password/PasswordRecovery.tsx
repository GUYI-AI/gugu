import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
import { usePasswordVault } from '@/lib/passwordBetaNotifications'
import { Button } from '../ui/Button'
import { RefreshFailed } from '../ui/RefreshFailed'
import { Sheet } from '../ui/Sheet'
import { SettingsGroup, SettingsNote, SettingsRow } from '../settings/SettingsPrimitives'
import { Confirm, RecoveryCodeSheet } from './passwordSheets'
import { usePasswordCommand } from './passwordModel'

/** Asked once, right after the first password is kept: the code is the account's own spare key, so it lives in
 * Settings → 账户 afterwards. */
export function RecoveryOffer({ snapshot }: { snapshot?: PasswordSnapshot }) {
  const { t } = useTranslation('settings')
  const { busy, error, run } = usePasswordCommand()
  const [shown, setShown] = useState<string>()
  const asking = snapshot?.sync?.state === 'ready' && snapshot.sync.recovery === 'ask' && snapshot.items.length > 0
  return <>
    {asking && !shown && <Sheet onClose={() => { void run({ type: 'sync-recovery-skip' }) }} desktopWidth="400px" mobileFitContent ariaLabel={t('passwords.recoveryOfferLabel')} testId="password-recovery-offer" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('passwords.recoveryOfferTitle')}</div>
        <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{t('passwords.recoveryOfferBody')}</div>
        {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy} onClick={() => { void run({ type: 'sync-recovery-skip' }) }}>{t('passwords.later')}</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run({ type: 'sync-recovery-create' }).then(reply => { if (reply?.recoveryCode) setShown(reply.recoveryCode) }) }}>{t('passwords.generate')}</Button>
        </div>
      </div>
    </Sheet>}
    {shown && <RecoveryCodeSheet code={shown} onClose={() => setShown(undefined)} />}
  </>
}

/** Settings → 账户: the recovery code belongs to the account, not to one device. Shown once a password is synced here. */
export function PasswordRecoveryGroup() {
  const { t } = useTranslation('settings')
  const { snapshot, failure, retry } = usePasswordVault()
  const { busy, error, run } = usePasswordCommand()
  const [asking, setAsking] = useState<'regenerate' | 'drop'>()
  const [shown, setShown] = useState<{ code: string; fresh: boolean }>()
  const sync = snapshot?.sync
  if (sync?.state !== 'ready') return null
  const create = async (fresh: boolean) => { const reply = await run({ type: 'sync-recovery-create' }); setAsking(undefined); if (reply?.recoveryCode) setShown({ code: reply.recoveryCode, fresh }) }
  const set = sync.recovery === 'set'
  return <>
    <SettingsGroup title={t('passwords.recoveryGroup')} footer={error || failure ? <>
      {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
      <RefreshFailed error={failure} onRetry={retry} />
    </> : undefined}>
      <SettingsRow title={t('passwords.recoveryCode')} description={t(set ? 'passwords.recoverySet' : 'passwords.recoveryUnset')}
        control={set
          ? <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('regenerate')}>{t('passwords.regenerate')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('drop')}>{t('passwords.remove')}</Button></div>
          : <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void create(false) }}>{t('passwords.generate')}</Button>} />
    </SettingsGroup>
    {asking === 'regenerate' && <Confirm title={t('passwords.regenerateTitle')} action={t('passwords.regenerate')} busy={busy} testId="password-recovery-regenerate"
      body={t('passwords.regenerateBody')} onClose={() => setAsking(undefined)} onConfirm={() => { void create(true) }} />}
    {asking === 'drop' && <Confirm title={t('passwords.removeTitle')} action={t('passwords.remove')} busy={busy} testId="password-recovery-remove"
      body={t('passwords.removeBody')} onClose={() => setAsking(undefined)}
      onConfirm={() => { void run({ type: 'sync-recovery-remove' }).then(() => setAsking(undefined)) }} />}
    {shown && <RecoveryCodeSheet code={shown.code} fresh={shown.fresh} onClose={() => setShown(undefined)} />}
  </>
}
