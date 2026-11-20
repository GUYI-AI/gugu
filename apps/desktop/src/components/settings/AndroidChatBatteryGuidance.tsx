import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { androidBatteryGuidance } from '../../lib/androidBatteryGuidance'
import { useReplica } from '../../lib/replica'
import { nativePhoneActions } from '../../mobile/phone-device/nativePhoneActions'
import { platform } from '../../platform'
import { Button } from '../ui/Button'
import { SettingsRow } from './SettingsPrimitives'

const SHOWN_KEY = 'gugu.android.chat-notifications.battery-guidance-v1'

/** Mounted on General entry, or when the user enables chat notifications there. */
export function AndroidChatBatteryGuidance() {
  const { t } = useTranslation('main')
  // This visit owns an interaction, not a second copy of the native permission reading.
  const [unseenOnEntry] = useState(() => !localStorage.getItem(SHOWN_KEY))
  const [allowedDuringVisit, setAllowedDuringVisit] = useState(false)
  const reading = useReplica(androidBatteryGuidance, unseenOnEntry ? [] : null)
  const guidance = reading.state === 'value' && reading.value.permission === 'prompt' ? reading.value : undefined

  useEffect(() => {
    // Consume the marker only after the guidance actually renders. A read completing after
    // leaving settings or disabling notifications must not consume this first opportunity.
    if (guidance) localStorage.setItem(SHOWN_KEY, 'shown')
  }, [guidance])

  if (!guidance || (allowedDuringVisit && !guidance.onePlus)) return null
  const restricted = !allowedDuringVisit
  return <SettingsRow
    stack
    description={<>
      {restricted && <span>{t('settings.general.notificationsAndroidBattery')}</span>}
      {guidance.onePlus && <>
        {restricted && <br />}
        {t('settings.general.notificationsAndroidOnePlus')}
      </>}
    </>}
    control={<div className="flex flex-wrap gap-2">
      {restricted && <Button variant="secondary" size="sm" onClick={() => {
        void platform.requestSystemPermission('batteryOptimization').then(state => {
          if (state === 'granted') setAllowedDuringVisit(true)
        }).catch(() => undefined)
      }}>{t('settings.general.notificationsAndroidBatteryAllow')}</Button>}
      {guidance.onePlus && <Button variant="secondary" size="sm" onClick={() => {
        void nativePhoneActions.openSettings({ target: 'app' }).catch(() => undefined)
      }}>{t('settings.general.notificationsAndroidAppInfo')}</Button>}
    </div>}
  />
}
