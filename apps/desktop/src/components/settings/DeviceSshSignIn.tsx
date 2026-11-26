import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signInSshMachine } from '../../lib/sshLinkChannel'
import type { SshLinkOpenResult } from '../../lib/sshLink'
import { InlineAction } from './addServer/InlineAction'

export function DeviceSshSignIn({ deviceId, name, hostKeyChanged }: {
  deviceId: string
  name: string
  hostKeyChanged: boolean
}) {
  const { t } = useTranslation('settings')
  const [attempt, setAttempt] = useState<'pending' | SshLinkOpenResult | null>(null)

  async function signIn() {
    setAttempt('pending')
    setAttempt(await signInSshMachine(deviceId))
  }

  const failure = attempt && attempt !== 'pending' && !attempt.ok ? attempt : null
  return (
    <span className="text-[var(--danger-fg)]" data-testid="settings-device-ssh-sign-in">
      {attempt === 'pending' ? (
        <span role="status">{t('devices.link.connecting', { name })}</span>
      ) : (
        <>
          {t(hostKeyChanged ? 'devices.loginState.sshHostKeyChanged' : 'devices.loginState.sshSignIn')}
          {' '}<InlineAction onClick={() => void signIn()} testId="settings-device-ssh-sign-in-action">
            {t(hostKeyChanged ? 'devices.retry' : 'devices.loginState.sshSignInAction')}
          </InlineAction>
        </>
      )}
      {failure && (
        <span role="alert" className="block">
          {failure.reason === 'hostKeyChanged' ? (
            <>
              {t('devices.link.hostKeyChanged', { name })}
              {failure.fingerprint && <span className="block break-all">{t('devices.addServer.newFingerprint', { fingerprint: failure.fingerprint })}</span>}
            </>
          ) : t('devices.loginState.sshSignInIncomplete')}
        </span>
      )}
    </span>
  )
}
