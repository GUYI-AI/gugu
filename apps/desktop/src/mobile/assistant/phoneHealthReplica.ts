import { Capacitor } from '@capacitor/core'
import { replica } from '@/lib/replica'
import { nativePhoneActions } from '../phone-device/nativePhoneActions'
import { readHealthSummary } from '../phone-device/phoneHealth'
import { PHONE_HEALTH_REFRESH_MS, readPhoneHealthView, type PhoneHealthView } from './phoneHealthView'


/** 与桌面健康页、手机的 health.summary 默认同一段:最近 7 天(含今天)。 */
const HEALTH_DAYS = 7

/**
 * This phone's health data, read natively (Health Connect / HealthKit) — device scope, no push: read again on its interval
 * while the page shows a summary (none while it asks for access), and when the window comes back. Not kept (health data).
 */
export const phoneHealth = replica({
  name: 'phoneHealth',
  scope: 'device',
  read: (): Promise<PhoneHealthView> => readPhoneHealthView({
    platform: Capacitor.getPlatform(),
    healthStatus: () => nativePhoneActions.healthStatus(),
    readSummary: (status) => readHealthSummary(HEALTH_DAYS, status),
  }),
  refreshEvery: (view) => (view?.state === 'ok' ? PHONE_HEALTH_REFRESH_MS : false),
  refreshOnFocus: true,
})
