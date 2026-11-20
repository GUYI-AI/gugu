import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PasswordSyncView, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { Lock } from '@/lib/icons'
import { Button } from '../ui/Button'
import { SettingsNote, SettingsPage } from '../settings/SettingsPrimitives'
import { Code, RecoverSheet, RecoveryCodeSheet } from './passwordSheets'
import './password-unlock.css'

type Command = (command: PasswordUiCommand) => Promise<Extract<PasswordUiReply, { ok: true }> | undefined>
type LockedSync = Extract<PasswordSyncView, { state: 'joining' | 'blocked' | 'refused' }>

/** The recovery result survives replacing the locked entry with the approved device's password list. */
export function PasswordUnlockGate({ sync, busy, error, run, clearError, children }: {
  sync?: PasswordSyncView; busy: boolean; error: string; run: Command; clearError(): void; children: ReactNode
}) {
  const [newCode, setNewCode] = useState<string>()
  const locked = sync?.state === 'joining' || sync?.state === 'blocked' || sync?.state === 'refused'
  return <>
    {locked ? <UnlockEntry sync={sync} busy={busy} error={error} run={run} clearError={clearError} onRecovered={setNewCode} /> : children}
    {newCode && <RecoveryCodeSheet code={newCode} fresh onClose={() => setNewCode(undefined)} />}
  </>
}

function UnlockEntry({ sync, busy, error, run, clearError, onRecovered }: {
  sync: LockedSync; busy: boolean; error: string; run: Command; clearError(): void; onRecovered(code: string): void
}) {
  const { t } = useTranslation('settings')
  const [recovering, setRecovering] = useState(false)
  const blocked = sync.state === 'blocked'
  return <SettingsPage data-testid="password-unlock-settings">
    <section className="password-unlock-entry" aria-labelledby="password-unlock-title">
      <span className="password-unlock-icon" aria-hidden="true"><Lock size={22} /></span>
      <h2 id="password-unlock-title" className="password-unlock-title">{t('passwords.locked')}</h2>
      {!blocked && <p className="password-unlock-instruction">{t('passwords.unlockInstruction')}</p>}
      {sync.state === 'refused'
        ? <Button disabled={busy} className="password-unlock-code-action" onClick={() => { void run({ type: 'sync-ask-again' }) }}>{t('passwords.askAgain')}</Button>
        : !blocked && <div className="password-unlock-code" data-testid="password-unlock-code">
          {sync.code ? <Code value={sync.code} /> : <span className="font-mono" aria-label={t('passwords.codeGenerating')}>··· ···</span>}
        </div>}
      <Button variant={blocked ? 'primary' : 'ghost'} className="password-unlock-recover" disabled={busy} onClick={() => { clearError(); setRecovering(true) }}>{t('passwords.unlockWithRecovery')}</Button>
      {!recovering && error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
    </section>
    {recovering && <RecoverSheet mode="unlock" busy={busy} error={error} onClose={() => { clearError(); setRecovering(false) }} onSubmit={async code => {
      const reply = await run({ type: 'sync-recover', code })
      if (reply?.recoveryCode) onRecovered(reply.recoveryCode)
    }} />}
  </SettingsPage>
}
