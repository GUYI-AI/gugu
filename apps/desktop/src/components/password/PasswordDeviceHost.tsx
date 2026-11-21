import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { PasswordSyncRequest } from '@gugu/core/shared/passwordBetaProtocol'
import { usePasswordVault, useOpenPasswordDevicePrompt } from '@/lib/passwordBetaNotifications'
import { LiveNotice } from '@/components/LiveNotice'
import { Button } from '../ui/Button'
import { RefreshFailed } from '../ui/RefreshFailed'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from '../settings/SettingsPrimitives'
import { promptedRequests, usePasswordCommand } from './passwordModel'
import { Code, RecoverSheet, RecoveryCodeSheet } from './passwordSheets'

const name = (t: TFunction<'settings'>, request: PasswordSyncRequest) => request.label || t('passwords.newDevice')

/**
 * The key to the passwords travels when a device joins the account, not from a settings page. On a device that already
 * has the passwords, a newly signed-in one asks here; on the new one, the same digits show in a notice that blocks
 * nothing. Either can be put aside; the notification list brings it back. Mounted once, above the whole signed-in app.
 */
export function PasswordDeviceHost() {
  const { t } = useTranslation('settings')
  const { snapshot, failure, retry } = usePasswordVault()
  const { busy, error, run, clear } = usePasswordCommand()
  const [aside, setAside] = useState<ReadonlySet<string>>(new Set())
  const [cardClosed, setCardClosed] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [newCode, setNewCode] = useState<string>()
  useOpenPasswordDevicePrompt(useCallback((deviceId: string | null) => {
    if (deviceId) setAside(previous => new Set([...previous].filter(id => id !== deviceId)))
    else setCardClosed(false)
  }, []))
  const sync = snapshot?.sync
  const request = promptedRequests(sync).find(entry => !aside.has(entry.deviceId))
  const joining = sync?.state === 'joining' || sync?.state === 'blocked' || sync?.state === 'refused' ? sync : undefined
  const putAside = (deviceId: string) => { clear(); setAside(previous => new Set([...previous, deviceId])) }
  const stale = <RefreshFailed error={failure} onRetry={retry} />
  return <>
    {request && <Sheet onClose={() => putAside(request.deviceId)} desktopWidth="380px" mobileFitContent ariaLabel={t('passwords.deviceRequestLabel')} testId="password-device-prompt" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col gap-3 px-5 pb-5 pt-6" data-stage={request.stage}>
        <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--fg)] [overflow-wrap:anywhere]">{t('passwords.allowDeviceTitle', { name: name(t, request) })}</h2>
        {request.stage === 'mismatch'
          ? <p className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{t('passwords.deviceMismatch')}</p>
          : <>
            <p className="text-[length:var(--font-body)] leading-[1.5] text-[var(--muted-fg)]">{t('passwords.deviceCompare')}</p>
            <div className="flex justify-center rounded-[var(--radius-control)] bg-[var(--muted)] py-3" data-testid="password-device-code">
              {request.code ? <Code value={request.code} /> : <span className="font-mono text-[length:var(--font-title)] tracking-[0.2em] text-[var(--muted-fg)]" aria-label={t('passwords.codeGenerating')}>··· ···</span>}
            </div>
          </>}
        {stale}
        {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
        {request.stage !== 'mismatch' && <Button variant="primary" size="lg" disabled={busy || request.stage !== 'compare'} data-testid="password-device-allow"
          onClick={() => { void run({ type: 'sync-approve', deviceId: request.deviceId }) }}>{t('passwords.allow')}</Button>}
        <Button variant="ghost" size="lg" disabled={busy} data-testid="password-device-deny"
          onClick={() => { void run({ type: 'sync-reject', deviceId: request.deviceId }) }}>{t(request.stage === 'mismatch' ? 'passwords.deny' : 'passwords.notMe')}</Button>
      </div>
    </Sheet>}
    {/* A freshly signed-in device is usually still in the first-run guide; the one notice outlet is mounted above it. */}
    {joining && !cardClosed && <LiveNotice noticeKey="password-join" title={t(joining.state === 'refused' ? 'passwords.joinRefused' : 'passwords.joinAsk')}
      ongoing onDismiss={() => setCardClosed(true)}
      description={<div role="status" data-testid="password-join-card" className="flex flex-col items-start gap-2">
        {joining.state === 'refused'
          ? <><div>{t('passwords.refusedHint')}</div>
            {error && <SettingsNote tone="danger" role="alert">{error}</SettingsNote>}
            <Button size="sm" disabled={busy} data-testid="password-join-again" onClick={() => { void run({ type: 'sync-ask-again' }) }}>{t('passwords.askAgain')}</Button></>
          : joining.state === 'joining' && joining.code
            ? <><Code value={joining.code} /><div>{t('passwords.joinCompare')}</div></>
            : <div>{t('passwords.joinOpenOther')}</div>}
        {stale}
        {joining.recovery && <Button variant="ghost" size="sm" onClick={() => { clear(); setRecovering(true) }}>{t('passwords.useRecoveryInstead')}</Button>}
      </div>} />}
    {recovering && <RecoverSheet busy={busy} error={error} onClose={() => setRecovering(false)}
      onSubmit={async code => { const reply = await run({ type: 'sync-recover', code }); if (reply?.recoveryCode) { setRecovering(false); setNewCode(reply.recoveryCode) } }} />}
    {newCode && <RecoveryCodeSheet code={newCode} fresh onClose={() => setNewCode(undefined)} />}
  </>
}
