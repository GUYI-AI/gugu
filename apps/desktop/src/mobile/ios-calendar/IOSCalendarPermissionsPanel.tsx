import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { IOSCalendarPermissionError, iosCalendarPermissions, type IOSCalendarPermissionClient, type IOSCalendarSnapshot } from './iosCalendarPermissions'

type PermissionRead =
  | { ownerId: string; kind: 'loading' }
  | { ownerId: string; kind: 'changing'; operation: 'connect' | 'disconnect' }
  | { ownerId: string; kind: 'ready'; status: IOSCalendarSnapshot; message?: string }
  | { ownerId: string; kind: 'failed'; message: string }

const STATUS_TEXT = {
  notDetermined: 'iosCalendar.notAuthorized', denied: 'iosCalendar.notAuthorized', restricted: 'iosCalendar.restricted',
  writeOnly: 'iosCalendar.writeOnly', fullAccess: 'iosCalendar.fullAccess',
} as const

function failureMessage(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code
  if (code === 'stale_context') return 'iosCalendar.staleContext'
  if (code === 'not_granted') return 'iosCalendar.notGranted'
  if (code === 'os_permission') return 'iosCalendar.osPermission'
  if (code === 'execution_unknown') return 'iosCalendar.executionUnknown'
  if (cause instanceof IOSCalendarPermissionError) return cause.code === 'unavailable' ? 'iosCalendar.unsupported' : 'iosCalendar.invalidStatus'
  return 'iosCalendar.readFailed'
}

function statusText(current: PermissionRead, t: TFunction<'settings'>): string {
  if (current.kind === 'loading') return t('iosCalendar.loading')
  if (current.kind === 'changing') return t(current.operation === 'connect' ? 'iosCalendar.connecting' : 'iosCalendar.disconnecting')
  if (current.kind === 'failed') return t('iosCalendar.unknown')
  if (current.status.calendarConnected) return t(current.status.authorization === 'fullAccess' ? 'iosCalendar.connected' : 'iosCalendar.revoked')
  return t('iosCalendar.disconnected', { authorization: t(STATUS_TEXT[current.status.authorization]) })
}

/** Native owner/category truth is required before displaying or changing a connection. */
export function IOSCalendarPermissionsPanel({ ownerId, client = iosCalendarPermissions }: {
  ownerId: string
  client?: IOSCalendarPermissionClient
}) {
  const { t } = useTranslation('settings')
  const [snapshot, setSnapshot] = useState<PermissionRead>({ ownerId, kind: 'loading' })
  const latestRequest = useRef<symbol | null>(null)
  const mutation = useRef<symbol | null>(null)
  const current = snapshot.ownerId === ownerId ? snapshot : { ownerId, kind: 'loading' as const }

  const refresh = useCallback(async () => {
    // The permission sheet can foreground the App before native finish completes.
    if (mutation.current) return
    const request = Symbol('calendar-permission-read')
    latestRequest.current = request
    setSnapshot({ ownerId, kind: 'loading' })
    try {
      const status = await client.read(ownerId)
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status })
    } catch (cause) {
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
    }
  }, [ownerId, client])

  const changeConnection = async (operation: 'connect' | 'disconnect') => {
    if (current.kind !== 'ready' || mutation.current) return
    const request = Symbol('calendar-connection-change')
    latestRequest.current = request
    mutation.current = request
    setSnapshot({ ownerId, kind: 'changing', operation })
    try {
      const status = await client[operation](current.status.binding)
      if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status })
    } catch (cause) {
      // A lost reply is not evidence that native persistence did not run.
      // Read actual state once; never replay the connection operation here.
      if (latestRequest.current !== request) return
      try {
        const status = await client.read(ownerId)
        if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'ready', status, message: failureMessage(cause) })
      } catch {
        if (latestRequest.current === request) setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
      }
    } finally {
      if (mutation.current === request) mutation.current = null
    }
  }

  useEffect(() => {
    let alive = true
    void refresh()
    const unsubscribe = platform.subscribeAppForeground(() => { if (alive) void refresh() }, cause => {
      if (!alive) return
      latestRequest.current = null
      mutation.current = null
      setSnapshot({ ownerId, kind: 'failed', message: failureMessage(cause) })
    })
    return () => { alive = false; latestRequest.current = null; mutation.current = null; unsubscribe() }
  }, [ownerId, refresh])

  const authorization = current.kind === 'ready' ? current.status.authorization : null
  const detail = authorization === 'writeOnly' ? 'iosCalendar.fullAccessRequired'
    : authorization === 'denied' || authorization === 'restricted' ? 'iosCalendar.enableInSettings'
      : null
  const message = current.kind === 'failed' || current.kind === 'ready' ? current.message : undefined
  const busy = current.kind === 'loading' || current.kind === 'changing'

  return <SettingsGroup title={t('iosCalendar.groupTitle')} presentation="navigation"
    footer={message ? <SettingsNote tone="danger" role="alert">{t(message)}</SettingsNote>
      : detail ? <SettingsNote>{t(detail)}</SettingsNote> : undefined}>
    <SettingsRow title={t('iosCalendar.calendar')} description={t('iosCalendar.description')} stack control={<div className="flex flex-wrap items-center gap-2">
      <span className="gg-settings-row-value" role="status">{statusText(current, t)}</span>
      <div className="flex flex-wrap gap-2">
      {current.kind === 'ready' && <Button size="sm" variant="secondary"
        onClick={() => void changeConnection(current.status.calendarConnected ? 'disconnect' : 'connect')}>
        {t(current.status.calendarConnected ? 'iosCalendar.disconnect' : 'iosCalendar.connect')}
      </Button>}
      <Button size="sm" variant="secondary" disabled={busy} aria-label={t('iosCalendar.refreshLabel')} onClick={() => void refresh()}>{t('iosCalendar.refresh')}</Button>
      </div>
    </div>} />
  </SettingsGroup>
}
