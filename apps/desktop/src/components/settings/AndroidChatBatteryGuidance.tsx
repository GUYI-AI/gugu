import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useReplica, valueOf } from '../../lib/replica'
import { systemPermission } from '../../lib/systemPermissions'
import { nativePhoneActions } from '../../mobile/phone-device/nativePhoneActions'
import { phoneInstallation } from '../../mobile/phone-device/phoneInstallation'
import { platform } from '../../platform'
import { Button } from '../ui/Button'
import { SettingsRow } from './SettingsPrimitives'

const SHOWN_KEY = 'gugu.android.chat-notifications.battery-guidance-v1'

/** Mounted on General entry, or when the user enables chat notifications there. */
export function AndroidChatBatteryGuidance() {
  const { t } = useTranslation('main')
  // This visit owns an interaction; the permission and the phone's maker are read through their replicas.
  const [unseenOnEntry] = useState(() => !localStorage.getItem(SHOWN_KEY))
  const [allowedDuringVisit, setAllowedDuringVisit] = useState(false)
  const permission = useReplica(systemPermission, unseenOnEntry ? ['batteryOptimization'] : null)
  const offered = valueOf(permission) === 'prompt' || allowedDuringVisit
  const installation = useReplica(phoneInstallation, unseenOnEntry ? [] : null)
  // The installation unreadable: not known to be a OnePlus (the battery part is still said).
  const onePlus = installation.state === 'unknown' ? undefined : installation.state === 'value'
    && [installation.value.info.brand, installation.value.info.manufacturer].some(name => name?.toLowerCase() === 'oneplus')
  const shown = offered && onePlus !== undefined

  useEffect(() => {
    // Consume the marker only after the guidance actually renders. A read completing after
    // leaving settings or disabling notifications must not consume this first opportunity.
    if (shown) localStorage.setItem(SHOWN_KEY, 'shown')
  }, [shown])

  if (!shown || (allowedDuringVisit && !onePlus)) return null
  const restricted = !allowedDuringVisit
  return <SettingsRow
    stack
    description={<>
      {restricted && <span>{t('settings.general.notificationsAndroidBattery')}</span>}
      {onePlus && <>
        {restricted && <br />}
        {t('settings.general.notificationsAndroidOnePlus')}
      </>}
    </>}
    control={<div className="flex flex-wrap gap-2">
      {restricted && <Button variant="secondary" size="sm" onClick={() => {
        void platform.requestSystemPermission('batteryOptimization').then(state => {
          // The request's answer is the permission now (the write's answer, into its replica).
          systemPermission.set(['batteryOptimization'], state)
          if (state === 'granted') setAllowedDuringVisit(true)
        }).catch(() => undefined)
      }}>{t('settings.general.notificationsAndroidBatteryAllow')}</Button>}
      {onePlus && <Button variant="secondary" size="sm" onClick={() => {
        void nativePhoneActions.openSettings({ target: 'app' }).catch(() => undefined)
      }}>{t('settings.general.notificationsAndroidAppInfo')}</Button>}
    </div>}
  />
}
