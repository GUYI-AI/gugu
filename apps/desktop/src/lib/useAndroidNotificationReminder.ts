import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { platform } from '../platform'
import { dismissNotice, notify } from './notices'
import {
  ANDROID_NOTIFICATION_PROBLEM_COPY, openAndroidNotificationSettings, readAndroidNotificationProblem,
} from './notificationDiagnostics'
import { useNotificationSettings } from './notificationSettings'
import { useAppActive } from './onScreenChat'

const NOTICE_KEY = 'android-chat-notification-settings'

export function useAndroidNotificationReminder(active: boolean): void {
  const { t } = useTranslation('main')
  const settings = useNotificationSettings()
  const foreground = useAppActive()
  const previous = useRef<string | null>(null)

  useEffect(() => {
    if (!platform.androidNotificationSettings || !active) return
    if (!settings.chatMessages) {
      previous.current = null
      dismissNotice(NOTICE_KEY)
      return
    }
    if (!foreground) return
    let current = true
    const silent = !settings.sound
    void readAndroidNotificationProblem(silent).then(problem => {
      if (!current || problem === undefined) return
      if (!problem) {
        previous.current = null
        dismissNotice(NOTICE_KEY)
        return
      }
      const key = problem === 'app-disabled' ? problem : `${problem}:${silent}`
      if (previous.current === key) return
      previous.current = key
      notify({
        key: NOTICE_KEY,
        tier: 'warning',
        title: t(ANDROID_NOTIFICATION_PROBLEM_COPY[problem]),
        action: {
          label: t('settings.general.notificationsAndroidOpen'),
          onClick: () => { void openAndroidNotificationSettings(silent, problem) },
        },
      })
    })
    return () => { current = false }
  }, [active, foreground, settings.chatMessages, settings.sound, t])
}
