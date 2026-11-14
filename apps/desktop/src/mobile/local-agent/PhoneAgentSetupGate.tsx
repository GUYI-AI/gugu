import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { SettingsNote, SettingsPage } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { readPhoneInstallation } from '../phone-device/phoneInstallation'
import { phoneInstallId } from '../phone-device/phoneDeviceSettings'
import { useTranslation } from 'react-i18next'
import { usePhoneHostIdentity } from './usePhoneHostIdentity'
import { retryPhoneHostPublication } from './phoneHostPublication'
import { PhoneAgentSetup } from './PhoneAgentSetup'
import { PhoneInstallationContext } from './PhoneInstallationContext'
import { phoneAgentSetupRequest, readPhoneAgentSetup, savePhoneAgentSetup, subscribePhoneAgentSetup, type PhoneAgentSetupProgress } from './PhoneAgentSetupState'

/** Keep the app roots mounted: enabling a host in the guide must start the real native lifecycle. */
export function PhoneAgentSetupGate({ ownerId, children }: { ownerId: string; children: ReactNode }) {
  const { t } = useTranslation('settings')
  const identity = usePhoneHostIdentity(ownerId)
  const binding = identity.binding
  const iosInstallationId = binding?.installationId ?? null
  const [setup, setSetup] = useState<{ ownerId: string; request: number; installId: string; progress: PhoneAgentSetupProgress } | null>(null)
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const requested = useSyncExternalStore(subscribePhoneAgentSetup, () => phoneAgentSetupRequest(ownerId), () => 0)
  const handled = useRef(new Map<string, number>())
  const currentSetup = setup?.ownerId === ownerId && setup.request === retry && (!identity.ios || setup.installId === iosInstallationId) ? setup : null

  useEffect(() => {
    if (platform.kind !== 'capacitor' || !platform.capabilities?.phoneAgentHost) return
    let alive = true
    setError(null)
    setVisible(false)
    if (identity.ios && !iosInstallationId) { setSetup(null); return }
    const installation = identity.ios ? Promise.resolve(iosInstallationId!)
      : readPhoneInstallation(ownerId).then(info => phoneInstallId(info.install_key ?? '', info.registration_id ?? '', info.previous_install_key))
    void installation.then((installId) => {
      if (!alive) return
      // Progress belongs to the native installation, never a restored WebView identifier.
      try {
        const progress = readPhoneAgentSetup(ownerId, installId)
        setSetup({ ownerId, request: retry, installId, progress })
        setError(null)
        setVisible(!progress.dismissed && !progress.completed)
      } catch (error) {
        rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
        // Corrupt presentation progress never authorizes tools. Let a deliberate next/finish save it again.
        setSetup({ ownerId, request: retry, installId, progress: { step: 'host', dismissed: false, completed: false } })
        setError(messageForUser(error))
        setVisible(true)
      }
    }).catch((error) => {
      rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
      if (alive) { setError(messageForUser(error)); setVisible(true) }
    })
    return () => { alive = false }
  }, [ownerId, retry, identity.ios, iosInstallationId])

  useEffect(() => {
    if (!requested || requested <= (handled.current.get(ownerId) ?? 0)) return
    if (identity.ios && !binding) { setVisible(true); return }
    setError(null)
    if (currentSetup) {
      handled.current.set(ownerId, requested)
      setVisible(true)
    } else setRetry((value) => value + 1)
  }, [ownerId, requested, currentSetup, identity.ios, binding])

  const save = (progress: PhoneAgentSetupProgress) => {
    if (!currentSetup) return false
    try {
      savePhoneAgentSetup(ownerId, currentSetup.installId, progress)
      setSetup({ ...currentSetup, progress })
      setError(null)
      return true
    } catch (error) {
      rendererLogger('actions/PhoneAgentSetupGate').error({ error: error }, 'action failed')
      setError(messageForUser(error))
      return false
    }
  }
  const dismiss = () => {
    if (currentSetup) save({ ...currentSetup.progress, dismissed: true })
    setVisible(false)
  }

  return (
    <PhoneInstallationContext.Provider value={currentSetup ? ownerId : null}>
      {children}
      {platform.capabilities?.phoneAgentHost && visible && (
        <Sheet onClose={dismiss} ariaLabel={t('devices.phoneActions.setupTitle')} titleId="phone-agent-setup-heading" fullScreenMobile testId="phone-agent-setup">
          {currentSetup ? (
            <PhoneAgentSetup
              key={`${ownerId}:${currentSetup.installId}`}
              ownerId={ownerId}
              onFinish={() => { if (save({ step: 'tools', dismissed: true, completed: true })) setVisible(false) }}
              onLater={dismiss}
              saveError={error}
            />
          ) : (
            <SettingsPage className="gg-phone-setup gg-phone-setup-unavailable">
              <h2 id="phone-agent-setup-heading" className="gg-phone-setup-heading">{t('devices.phoneActions.setupUnavailable')}</h2>
              <SettingsNote role="alert">{error ?? t('devices.phoneActions.host.waiting')}</SettingsNote>
              <div className="flex gap-2">
                <Button onClick={() => {
                  if (identity.ios && !binding) void retryPhoneHostPublication().catch(cause => {
                    rendererLogger('actions/PhoneAgentSetupGate').error({ error: cause }, 'action failed')
                    setError(t('devices.phoneActions.host.operationFailed'))
                  })
                  setRetry((value) => value + 1)
                }}>{t('devices.retry')}</Button>
                <Button variant="ghost" onClick={dismiss}>{t('devices.phoneActions.setupBack')}</Button>
              </div>
            </SettingsPage>
          )}
        </Sheet>
      )}
    </PhoneInstallationContext.Provider>
  )
}
