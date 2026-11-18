import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { restartPhoneAgentHost, stopPhoneAgentHost, usePhoneDevice } from '../phone-device/phoneDeviceRuntime'
import { setPhoneAgentHostEnabled, usePhoneDeviceSettings } from '../phone-device/phoneDeviceSettings'
import { phoneAgentAvailable } from './nativeAgent'
import { Capacitor } from '@capacitor/core'
import { platform } from '@/platform'
import { PhoneAgentHostView } from './PhoneAgentHostView'
const IOSPhoneAgentHostControl = lazy(() => import('./IOSPhoneAgentHostControl').then(module => ({ default: module.IOSPhoneAgentHostControl })))

/** Hosting is a device setting; Agent creation and conversations stay in their existing flows. */
function AndroidPhoneAgentHostControl({ ownerId, setup, summary }: { ownerId: string; setup?: boolean; summary?: boolean }) {
  const { t } = useTranslation('settings')
  const phone = usePhoneDevice()
  const settings = usePhoneDeviceSettings(ownerId)
  const [changing, setChanging] = useState<'stop' | 'restart' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const host = phone.host?.ownerId === ownerId ? phone.host : null
  const ready = settings.hostEnabled && host?.ready && host.status === 'ready'
  const failed = settings.hostEnabled && (host?.status === 'failed' || host?.status === 'interrupted' || host?.status === 'stopped' || phone.link.state === 'error')
  const hostError = !settings.hostEnabled ? null
    : host?.error ?? (host?.status === 'failed' ? host.message : undefined)
      ?? (phone.link.state === 'error' ? phone.link.message : undefined)
      ?? (host?.status === 'interrupted' ? t('devices.phoneActions.host.interruptedHint') : null)
  const statusText = changing === 'stop' ? t('devices.phoneActions.host.stopping')
    : changing === 'restart' ? t('devices.phoneActions.host.starting')
      : error ? t('devices.phoneActions.host.operationFailed')
        : !settings.hostEnabled ? (host?.status === 'stopped' ? t('devices.phoneActions.host.stopped') : t('devices.phoneActions.host.disabled'))
          : ready ? t('devices.phoneActions.host.ready')
            : host?.status === 'interrupted' ? t('devices.phoneActions.host.interrupted')
              : host?.status === 'stopped' ? t('devices.phoneActions.host.stopped')
                : failed ? t('devices.phoneActions.host.failed') : t('devices.phoneActions.host.starting')

  const changeHost = async (kind: 'stop' | 'restart') => {
    if (changing) return
    setChanging(kind)
    setError(null)
    try {
      if (kind === 'stop') await stopPhoneAgentHost(ownerId)
      else await restartPhoneAgentHost(ownerId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChanging(null)
    }
  }

  if (!phoneAgentAvailable()) return null

  return <PhoneAgentHostView setup={setup} summary={summary} enabled={settings.hostEnabled} ready={!!ready} failed={!!failed}
    changing={changing} error={error} hostError={hostError} statusText={statusText} changeHost={changeHost}
    enable={() => { setError(null); setPhoneAgentHostEnabled(ownerId, true) }} />
}

export function PhoneAgentHostControl(props: { ownerId: string; setup?: boolean; summary?: boolean }) {
  if (!platform.capabilities?.phoneAgentHost) return null
  return Capacitor.getPlatform() === 'ios'
    ? <Suspense fallback={null}><IOSPhoneAgentHostControl {...props} /></Suspense>
    : <AndroidPhoneAgentHostControl {...props} />
}
