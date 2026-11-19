import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicePreferences } from '@/lib/devicePreferences'
import { rendererLogger } from '@/lib/log'
import { platform } from '../platform'
import { claimBackgroundWatch } from './backgroundWatchClaims'

const log = rendererLogger('mobile/chat-background-watch')

export function AndroidChatBackgroundWatch({ active }: { active: boolean }) {
  const { t } = useTranslation('main')
  const { chatMessages } = useDevicePreferences()
  const label = t('settings.general.notificationsAndroidReceiving')

  useEffect(() => {
    if (!active || !chatMessages || !platform.capabilities.backgroundWatch || !platform.subscribeAppActive) return
    let foreground = false
    let revision = 0
    let release: (() => void) | undefined
    function checkPermission() {
      if (!foreground) return
      const check = ++revision
      void platform.checkSystemPermission('notifications').then(state => {
        if (check !== revision || !foreground) return
        if (state === 'granted') {
          release ??= claimBackgroundWatch('chatNotifications', label, '')
        } else {
          release?.()
          release = undefined
        }
      }).catch(error => log.warn({ error }, 'Reading Android notification permission failed'))
    }
    const unsubscribe = platform.subscribeAppActive(next => {
      foreground = next
      ++revision
      checkPermission()
    })
    window.addEventListener('gugu:android-notification-permission', checkPermission)
    return () => {
      foreground = false
      ++revision
      release?.()
      unsubscribe()
      window.removeEventListener('gugu:android-notification-permission', checkPermission)
    }
  }, [active, chatMessages, label])

  return null
}
