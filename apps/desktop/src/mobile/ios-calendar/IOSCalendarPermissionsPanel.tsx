import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { platform } from '@/platform'
import { IOSCalendarPermissionError, type IOSCalendarSnapshot } from './iosCalendarPermissions'
import { iosCalendarClient, iosCalendarConnection } from './iosCalendarConnection'
import { useReplica } from '@/lib/replica'
import { waitForCalendarAppActive } from './waitForCalendarAppActive'

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

/** A connect / disconnect of this panel: going, or settled with what to say (a message, or a failure with nothing to show). */
type Change =
  | { ownerId: string; kind: 'changing'; operation: 'connect' | 'disconnect' }
  | { ownerId: string; kind: 'settled'; message?: string }
  | { ownerId: string; kind: 'failed'; message: string }

/** Native owner/category truth is required before displaying or changing a connection. */
export function IOSCalendarPermissionsPanel({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation('settings')
  // The connection is the account's iosCalendarConnection replica (read on open, dropped and read again on foreground).
  const reading = useReplica(iosCalendarConnection, [])
  const [change, setChange] = useState<Change | null>(null)
  /** The foreground observer failed: nothing read after it is shown until the person asks again. */
  const [observerFailure, setObserverFailure] = useState<{ ownerId: string; message: string } | null>(null)
  const mutation = useRef<symbol | null>(null)
  const recovery = useRef<AbortController | null>(null)
  const owner = useRef(ownerId)
  owner.current = ownerId
  const shownChange = change?.ownerId === ownerId ? change : null
  const shownFailure = observerFailure?.ownerId === ownerId ? observerFailure : null
  const current: PermissionRead = shownChange?.kind === 'changing' ? { ownerId, kind: 'changing', operation: shownChange.operation }
    : shownChange?.kind === 'failed' ? { ownerId, kind: 'failed', message: shownChange.message }
    : shownFailure ? { ownerId, kind: 'failed', message: shownFailure.message }
    : reading.state === 'unknown' ? { ownerId, kind: 'loading' }
    : reading.state === 'error' || reading.error ? { ownerId, kind: 'failed', message: failureMessage(reading.error) }
    : { ownerId, kind: 'ready', status: reading.value, ...(shownChange?.kind === 'settled' && shownChange.message ? { message: shownChange.message } : {}) }

  // Read again (the reload button, the App back in front): the shown state is dropped while it is checked.
  const recheck = useCallback(() => {
    // The permission sheet can foreground the App before native finish completes.
    if (mutation.current) return
    setChange(null)
    setObserverFailure(null)
    // Dropped (unknown) until the native answer lands; a read on its way is replaced.
    void iosCalendarConnection.reset()
  }, [])

  const changeConnection = async (operation: 'connect' | 'disconnect') => {
    if (current.kind !== 'ready' || mutation.current) return
    const request = Symbol('calendar-connection-change')
    const startedFor = ownerId
    const entry = iosCalendarConnection.at()
    const still = () => mutation.current === request && owner.current === startedFor
    mutation.current = request
    setChange({ ownerId: startedFor, kind: 'changing', operation })
    let recoveryController: AbortController | undefined
    const client = iosCalendarClient()
    try {
      const status = await client[operation](current.status.binding)
      if (!still()) return
      entry.set(status)
      setChange(null)
    } catch (cause) {
      // A lost reply is not evidence that native persistence did not run.
      // Read actual state once; never replay the connection operation here.
      if (!still()) return
      try {
        let status: IOSCalendarSnapshot
        try {
          status = await client.read(startedFor)
        } catch (readFailure) {
          // EventKit can answer before the dismissed sheet restores the native
          // foreground guard. Retry only the read once, never the OS request.
          if (operation !== 'connect' || (cause as { code?: unknown } | null)?.code !== 'not_granted'
            || (readFailure as { code?: unknown } | null)?.code !== 'not_granted') throw readFailure
          const controller = new AbortController()
          recoveryController = controller
          recovery.current = controller
          const active = await waitForCalendarAppActive(controller.signal)
          if (!still()) return
          if (!active) throw readFailure
          status = await client.read(startedFor)
        }
        if (!still()) return
        const denied = status.authorization === 'denied' || status.authorization === 'restricted'
        const foregroundRefusal = (cause as { code?: unknown } | null)?.code === 'not_granted'
        entry.set(status)
        setChange({ ownerId: startedFor, kind: 'settled', ...(denied && foregroundRefusal ? {} : { message: failureMessage(cause) }) })
      } catch {
        if (still()) setChange({ ownerId: startedFor, kind: 'failed', message: failureMessage(cause) })
      }
    } finally {
      recoveryController?.abort()
      if (recovery.current === recoveryController) recovery.current = null
      if (mutation.current === request) mutation.current = null
    }
  }

  // The App back in front (the person may have changed the grant in system settings): read again. A failed observer
  // means later changes would go unnoticed: say so, and show nothing read after it.
  useEffect(() => {
    let alive = true
    const unsubscribe = platform.subscribeAppForeground(() => { if (alive) recheck() }, cause => {
      if (!alive) return
      recovery.current?.abort()
      mutation.current = null
      setChange(null)
      setObserverFailure({ ownerId, message: failureMessage(cause) })
    })
    return () => { alive = false; mutation.current = null; recovery.current?.abort(); unsubscribe() }
  }, [ownerId, recheck])

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
      <Button size="sm" variant="secondary" disabled={busy} aria-label={t('iosCalendar.refreshLabel')} onClick={recheck}>{t('iosCalendar.refresh')}</Button>
      </div>
    </div>} />
  </SettingsGroup>
}
