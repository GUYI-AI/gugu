import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n/registerSettingsCatalog'
import { platform } from '@/platform'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from '../settings/SettingsPrimitives'

/** Pieces shared by Settings → 密码, Settings → 账户 and the device prompt. */
/** The 6 digits both devices show, grouped 3 + 3 so they are easy to compare aloud. */
export function Code({ value }: { value: string }) {
  const { t } = useTranslation('settings')
  return <span className="font-mono text-[length:var(--font-title)] font-semibold tracking-[0.2em] text-[var(--fg)]" aria-label={t('passwords.codeLabel', { digits: value.split('').join(' ') })}>
    {value.slice(0, 3)} {value.slice(3)}</span>
}
/** A small confirm sheet in the same shape as the credential delete confirm. */
export function Confirm({ title, body, action, busy, onConfirm, onClose, testId }: { title: string; body: string; action: string; busy: boolean; onConfirm(): void; onClose(): void; testId: string }) {
  const { t } = useTranslation('settings')
  return <Sheet onClose={onClose} desktopWidth="400px" mobileFitContent ariaLabel={title} testId={testId} zIndex="var(--z-settings-modal)">
    <div className="flex flex-col gap-3 p-[18px]">
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{title}</div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{body}</div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>{t('passwords.cancel')}</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{action}</Button>
      </div>
    </div>
  </Sheet>
}
/** Shown once, right after the code is made. Where to keep it is said here, the only place it matters. */
export function RecoveryCodeSheet({ code, fresh, onClose }: { code: string; fresh?: boolean; onClose(): void }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return <Sheet onClose={onClose} desktopWidth="440px" mobileFitContent ariaLabel={t('passwords.recoveryCode')} testId="password-recovery-code" zIndex="var(--z-settings-modal)">
    <div className="flex flex-col gap-3 p-[18px]">
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t(fresh ? 'passwords.newRecoveryCode' : 'passwords.recoveryCode')}</div>
      <div className="select-text rounded-[var(--radius-control)] bg-[var(--muted)] px-4 py-3 text-center font-mono text-[length:var(--font-title)] font-semibold tracking-[0.08em] text-[var(--fg)]">{code}</div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">
        {t('passwords.recoveryKeep')}{fresh ? t('passwords.recoveryPrevious') : ''}
      </div>
      <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">
        {t('passwords.recoveryWarning')}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => { void platform.writeClipboardText(code).then(() => setCopied(true), () => {}) }}>{t(copied ? 'passwords.copied' : 'passwords.copy')}</Button>
        <Button size="sm" variant="primary" onClick={onClose}>{t('passwords.savedIt')}</Button>
      </div>
    </div>
  </Sheet>
}
export function RecoverSheet({ busy, error, onSubmit, onClose, mode = 'recover' }: { busy: boolean; error: string; onSubmit(code: string): Promise<void>; onClose(): void; mode?: 'recover' | 'unlock' }) {
  const { t } = useTranslation('settings')
  const [code, setCode] = useState('')
  const unlocking = mode === 'unlock'
  const title = t(unlocking ? 'passwords.unlockWithRecovery' : 'passwords.recoverTitle')
  useEffect(() => () => setCode(''), [])
  return <Sheet onClose={onClose} desktopWidth={unlocking ? '380px' : '440px'} mobileFitContent ariaLabel={title} testId="password-recover" zIndex="var(--z-settings-modal)">
    <form className={`flex flex-col gap-3 ${unlocking ? 'px-6 py-[22px]' : 'p-[18px]'}`} onSubmit={event => { event.preventDefault(); void onSubmit(code) }}>
      <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{title}</div>
      {!unlocking && <div className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{t('passwords.recoverBody')}</div>}
      <Field.Root><Field.Input required aria-label={t('passwords.recoveryCode')} autoComplete="off" spellCheck={false} className="font-mono" value={code}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" onChange={event => setCode(event.target.value)} /></Field.Root>
      {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
      <div className="flex justify-end gap-2">
        <Button size={unlocking ? 'md' : 'sm'} onClick={onClose}>{t('passwords.cancel')}</Button>
        <Button size={unlocking ? 'md' : 'sm'} variant="primary" type="submit" disabled={busy || !code.trim()}>{t(unlocking ? 'passwords.unlock' : 'passwords.recover')}</Button>
      </div>
    </form>
  </Sheet>
}
