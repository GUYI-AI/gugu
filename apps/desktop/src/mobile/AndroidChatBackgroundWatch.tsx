import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicePreferences } from '@/lib/devicePreferences'
import { useReplica, valueOf } from '@/lib/replica'
import { systemPermission } from '@/lib/systemPermissions'
import { platform } from '../platform'
import { useAndroidPushConfirmed } from './android-push/androidPushState'
import { claimBackgroundWatch } from './backgroundWatchClaims'

export function AndroidChatBackgroundWatch({ active }: { active: boolean }) {
  const remotePush = useAndroidPushConfirmed()
  const { t } = useTranslation('main')
  const { chatMessages } = useDevicePreferences()
  const label = t('settings.general.notificationsAndroidReceiving')
  const on = active && chatMessages && !remotePush && platform.capabilities.backgroundWatch && !!platform.subscribeAppActive
  // The notification permission is the device's replica (read again back in the foreground, and after a request below).
  const permission = valueOf(useReplica(systemPermission, on ? ['notifications'] : null))
  const [foreground, setForeground] = useState(false)
  const release = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    if (!on) return
    const unsubscribe = platform.subscribeAppActive!(setForeground)
    const requested = () => { void systemPermission.refresh('notifications') }
    window.addEventListener('gugu:android-notification-permission', requested)
    return () => {
      setForeground(false)
      release.current?.()
      release.current = undefined
      unsubscribe()
      window.removeEventListener('gugu:android-notification-permission', requested)
    }
  }, [on, label])

  useEffect(() => {
    // Claimed or released only in the foreground: the system does not let a foreground service start from the background.
    if (!on || !foreground || permission === undefined) return
    if (permission === 'granted') {
      release.current ??= claimBackgroundWatch('chatNotifications', label, '')
    } else {
      release.current?.()
      release.current = undefined
    }
  }, [on, foreground, permission, label])

  return null
}
