import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signInSshMachine } from '../../lib/sshLinkChannel'
import type { SshLinkOpenResult } from '../../lib/sshLink'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { SshIdentityDetails } from './addServer/SshHostKeyChanged'
import { InlineAction } from './addServer/InlineAction'

export function DeviceSshSignIn({ deviceId, name, hostKeyChanged }: {
  deviceId: string
  name: string
  hostKeyChanged: boolean
}) {
  const { t } = useTranslation('settings')
  const { translate } = useSessionMessages()
  const [attempt, setAttempt] = useState<'pending' | SshLinkOpenResult | null>(null)

  async function signIn() {
    setAttempt('pending')
    const result = await signInSshMachine(deviceId)
    setAttempt(!result.ok && result.cancelled ? null : result)
  }

  const failure = attempt && attempt !== 'pending' && !attempt.ok ? attempt : null
  const hostKey = failure?.hostKey
  const summary = hostKeyChanged ? translate('remoteHost.ssh.hostKeyChanged') : t('devices.loginState.sshSignIn')
  return (
    <span className="text-[var(--danger-fg)]" data-testid="settings-device-ssh-sign-in">
      {attempt === 'pending' ? (
        <span role="status">{t('devices.link.connecting', { name })}</span>
      ) : (
        <>
          {failure ? (
            <span role="alert">
              {failure.reason === 'hostKeyChanged' ? t('devices.link.hostKeyChanged', { name }) : t('devices.loginState.sshSignInIncomplete')}
              {hostKey && <SshIdentityDetails hostKey={hostKey} />}
            </span>
          ) : summary}
          {' '}<InlineAction onClick={() => void signIn()} testId="settings-device-ssh-sign-in-action">
            {hostKeyChanged && !hostKey ? translate('remoteHost.ssh.verify') : t(hostKeyChanged ? 'devices.retry' : 'devices.loginState.sshSignInAction')}
          </InlineAction>
          {hostKey && <>{' '}<InlineAction onClick={() => setAttempt(null)}>{t('devices.cancel')}</InlineAction></>}
        </>
      )}
    </span>
  )
}
