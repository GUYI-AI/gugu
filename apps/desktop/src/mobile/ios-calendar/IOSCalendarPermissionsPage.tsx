import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { getIOSOwnerPublicationSnapshot, retryIOSOwnerPublication, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import type { IOSOwnerPublicationState } from '../ios-runtime/iosOwnerPublication'
import { IOSCalendarPermissionsPanel } from './IOSCalendarPermissionsPanel'
import { iosCalendarPermissionsAvailable } from './iosCalendarPermissionsAvailability'

const STATE_LABEL = { unavailable: 'iosCalendar.unavailable', waiting: 'iosCalendar.waiting', publishing: 'iosCalendar.publishing', retiring: 'iosCalendar.retiring', failed: 'iosCalendar.failed', stopped: 'iosCalendar.stopped' } as const
function failureText(state: Extract<IOSOwnerPublicationState, { status: 'failed' }>): string {
  if (state.error.code === 'retirement_failed') return 'iosCalendar.retirementFailed'
  if (state.error.code === 'stale_context') return 'iosCalendar.identityChanged'
  return 'iosCalendar.verificationFailed'
}
function detail(state: IOSOwnerPublicationState): string {
  if (state.status === 'failed') return failureText(state)
  if (state.status === 'retiring') return 'iosCalendar.retiringDetail'
  if (state.status === 'stopped') return 'iosCalendar.stoppedDetail'
  if (state.status === 'publishing') return 'iosCalendar.publishingDetail'
  if (state.status === 'waiting') return 'iosCalendar.waitingDetail'
  if (state.status === 'unavailable') return 'iosCalendar.unavailableDetail'
  return 'iosCalendar.ownerChangedDetail'
}

/** Route/capability registration stays with A; this page never enables Android phone capabilities. */
export function IOSCalendarPermissionsPage({ ownerId }: { ownerId: string | null }) {
  const { t } = useTranslation('settings')
  const publication = useSyncExternalStore(subscribeIOSOwnerPublication, getIOSOwnerPublicationSnapshot, getIOSOwnerPublicationSnapshot)
  const [retry, setRetry] = useState<{ ownerId: string | null; pending: boolean; failed: boolean } | null>(null)
  const latestRetry = useRef<symbol | null>(null)
  useEffect(() => () => { latestRetry.current = null }, [ownerId])

  const available = iosCalendarPermissionsAvailable()
  const currentRetry = retry?.ownerId === ownerId ? retry : null
  const retryPublication = async () => {
    if (!ownerId || !available || latestRetry.current) return
    const request = Symbol('ios-owner-retry')
    latestRetry.current = request
    setRetry({ ownerId, pending: true, failed: false })
    try {
      await retryIOSOwnerPublication()
      if (latestRetry.current === request) setRetry({ ownerId, pending: false, failed: false })
    } catch {
      if (latestRetry.current === request) setRetry({ ownerId, pending: false, failed: true })
    } finally {
      if (latestRetry.current === request) latestRetry.current = null
    }
  }

  if (available && ownerId && publication.status === 'ready' && publication.binding.ownerId === ownerId) {
    return <SettingsPage data-testid="settings-permissions"><IOSCalendarPermissionsPanel key={publication.binding.deviceId} ownerId={ownerId} /></SettingsPage>
  }

  const failed = Boolean(available && ownerId && (publication.status === 'failed' || currentRetry?.failed))
  const message = !available ? 'iosCalendar.unsupported' : !ownerId ? 'iosCalendar.signInFirst'
    : currentRetry?.failed ? 'iosCalendar.retryFailed' : detail(publication)
  const label = !available ? 'iosCalendar.unavailable' : !ownerId ? 'iosCalendar.signedOut' : publication.status === 'ready' ? 'iosCalendar.ownerChanged' : STATE_LABEL[publication.status]
  return <SettingsPage data-testid="settings-permissions">
    <SettingsGroup title={t('iosCalendar.groupTitle')} presentation="navigation"
      footer={<SettingsNote role={failed ? 'alert' : 'status'} tone={failed ? 'danger' : undefined}>{t(message)}</SettingsNote>}>
      <SettingsRow title={t('iosCalendar.calendar')} description={t('iosCalendar.description')} control={<div className="flex items-center gap-2">
        <span className="gg-settings-row-value">{t(label)}</span>
        {available && ownerId && publication.status !== 'stopped' && <Button size="sm" variant="secondary" disabled={currentRetry?.pending}
          aria-label={t('iosCalendar.retryLabel')} onClick={() => void retryPublication()}>{t('iosCalendar.retry')}</Button>}
      </div>} />
    </SettingsGroup>
  </SettingsPage>
}
