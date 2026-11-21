import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n/registerMobileWorkspaceCatalog'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { ChevronRight } from '@/lib/icons'
import { changeSystemPermission, systemPermissionRows, useSystemPermissionStates } from '@/lib/systemPermissions'
import { messageForUser } from '@/lib/userFacingError'
import { platform } from '@/platform'
import { requirementGranted, type PhoneActionGroup, type PhoneOsState } from './phoneActionCatalog'
import { HEALTH_TYPES } from './nativePhoneActions'
import { connectPhoneActionGroupChoice, setPhoneActionGroup, usePhoneDeviceSettings } from './phoneDeviceSettings'
import { openPhonePermissionSettings, requestPhoneRequirement } from './phonePermissionActions'
import { phoneOsState, readPhoneOsState, refreshPhoneDevice } from './phoneDeviceRuntime'
import { useReplica } from '@/lib/replica'
import { rendererLogger } from '@/lib/log'
import { PHONE_PERMISSION_ROWS, type PhonePermissionRow } from './phonePermissionRows'
import { usePhonePermissionReporter } from './usePhonePermissionReporter'

const log = rendererLogger('phone-permissions')

function unsupported(group: PhoneActionGroup, os: PhoneOsState): boolean {
  return group === 'alarm' ? !os.special.alarm_app : group === 'health' ? !os.health.supported : ['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported
}

/** The sole phone permission manager. Rendering, visiting and foreground refresh only read Android state. */
export function PhonePermissionsList({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation('mobileWorkspace')
  const { t: tMain } = useTranslation('main')
  const settings = usePhoneDeviceSettings(ownerId)
  const report = usePhonePermissionReporter(ownerId)
  const osReading = useReplica(phoneOsState, [])
  // Read on open and again back from the system settings; a failed read again ❌ shows the earlier answer as now.
  const read: 'loading' | 'ready' | 'failed' = osReading.state === 'unknown' ? 'loading' : osReading.state === 'value' && !osReading.error ? 'ready' : 'failed'
  const os = osReading.state === 'value' && !osReading.error ? osReading.value : null
  const systemRows = systemPermissionRows()
  const system = useSystemPermissionStates(systemRows.map(row => row.permission))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => refreshPhoneDevice().catch((error: unknown) => log.warn({ error: String(error) }, 'phone re-read or re-registration failed')), [])
  useEffect(() => platform.subscribeAppForeground(() => { void refresh() }, () => undefined), [refresh])
  const act = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key); setError(null)
    try { await action() } catch (cause) { setError(messageForUser(cause)) }
    finally { await Promise.all([refresh(), system.refresh()]); setBusy(null) }
  }
  const choose = async ({ group, requirement }: PhonePermissionRow) => {
    if (!os || read !== 'ready') return
    const selected = settings.enabled && settings.groups[group]
    if (group === 'alarm' && selected) {
      setPhoneActionGroup(ownerId, group, false); report('group-enabled', false, group); return
    }
    if (!requirementGranted(requirement, os)) {
      await requestPhoneRequirement(requirement, os)
      if (!requirementGranted(requirement, await readPhoneOsState())) return
    } else if (group === 'location' && !os.special.location_enabled) await openPhonePermissionSettings('location')
    else if (selected) {
      if (group === 'health' && (os.health.granted_types.length < HEALTH_TYPES.length || (os.health.background_supported && !os.health.background_granted))) await requestPhoneRequirement('health_connect', os)
      else if (group === 'photos' && (!os.data?.images || !os.data.videos)) await requestPhoneRequirement('photos', os)
      else if (group !== 'alarm') await openPhonePermissionSettings(requirement === 'notification_listener' ? 'notification_listener' : requirement === 'dnd_access' ? 'dnd' : group === 'health' ? 'health' : 'app')
    }
    if (!selected) connectPhoneActionGroupChoice(ownerId, group)
    report('group-enabled', true, group)
  }
  const status = ({ group, requirement }: PhonePermissionRow) => {
    if (read === 'failed') return t('phonePermissions.unreadable')
    if (read !== 'ready' || !os) return '…'
    if ((group === 'health' && os.health.old_app) || (['sms', 'recordings', 'photos'].includes(group) && !os.data?.supported)) return t('phonePermissions.unreadable')
    if (unsupported(group, os) || !requirementGranted(requirement, os)) return t('phonePermissions.off')
    if (group === 'location' && !os.special.location_enabled) return t('phonePermissions.off')
    return settings.enabled && settings.groups[group] ? t('phonePermissions.on') : t('phonePermissions.off')
  }
  const feedback = [error, read === 'failed' || system.failed ? t('phonePermissions.partialReadFailed') : null].filter(Boolean).join('；')
  const trailing = (text: string) => <><span className="gg-settings-row-value">{text}</span><ChevronRight className="size-4" aria-hidden="true" /></>
  return <div className="gg-phone-capabilities" data-testid="phone-permissions-list"><SettingsGroup title="咕咕" presentation="navigation">
    {systemRows.map(({ permission, labelKey }) => {
      const state = system.states[permission]
      const text = state === 'granted' ? t('phonePermissions.on') : state === 'unreadable' || system.failed ? t('phonePermissions.unreadable') : state ? t('phonePermissions.off') : '…'
      return <SettingsRow key={`system:${permission}`} title={tMain(labelKey)} description={t(`phonePermissions.systemPurpose.${permission}`)} data-testid={`phone-device-system-${permission}`} aria-disabled={busy !== null}
        control={trailing(text)} onClick={() => void act(`system:${permission}`, async () => {
          if (!(await changeSystemPermission(permission, state ?? 'unreadable'))) throw new Error(t('phonePermissions.openSettingsFailed'))
        })} />
    })}
    </SettingsGroup><SettingsGroup title={t('phonePermissions.agentGroup')} presentation="navigation">
    {PHONE_PERMISSION_ROWS.map(row => <SettingsRow key={row.id} title={t(`phonePermissions.rows.${row.id}.title`)} description={t(`phonePermissions.rows.${row.id}.purpose`)} data-testid={`phone-device-group-${row.id}`}
      aria-label={t('phonePermissions.rowLabel', { title: t(`phonePermissions.rows.${row.id}.title`), status: status(row) })} aria-disabled={busy !== null || (!!os && unsupported(row.group, os))} control={trailing(status(row))}
      onClick={() => {
        if (busy || (os && unsupported(row.group, os))) return
        if (read !== 'ready' || !os) { void refresh(); return }
        void act(row.id, () => choose(row))
      }} />)}
  </SettingsGroup>{feedback && <SettingsNote role="alert" tone="danger">{feedback}</SettingsNote>}</div>
}
