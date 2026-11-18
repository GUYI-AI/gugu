import '@/i18n/registerSettingsCatalog'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import '../phone-device/phone-device.css'

export interface PhoneAgentHostViewProps {
  setup?: boolean
  summary?: boolean
  enabled: boolean
  ready: boolean
  failed: boolean
  changing: 'stop' | 'restart' | null
  error: string | null
  hostError: string | null
  statusText: string
  changeHost: (kind: 'stop' | 'restart') => Promise<void>
  enable: () => void
  unavailable?: boolean
}

/** One existing layout for either native host protocol. */
export function PhoneAgentHostView({ setup, summary, enabled, ready, failed, changing, error, hostError, statusText, changeHost, enable, unavailable }: PhoneAgentHostViewProps) {
  const { t } = useTranslation('settings')
  if (summary) return (
    <div className="gg-phone-setup-field gg-phone-setup-host-summary">
      <div className="gg-phone-setup-field-main">
        <span className="gg-phone-setup-field-title">{t('devices.phoneActions.host.title')}</span>
        <span className="gg-phone-capability-status" role="status">{statusText}</span>
      </div>
    </div>
  )

  if (setup) return (
    <div className="gg-phone-setup-field" data-state={ready ? 'granted' : undefined}>
      <div className="gg-phone-setup-field-main">
        <div className="gg-phone-setup-field-copy">
          <span className="gg-phone-setup-field-title">{t('devices.phoneActions.host.title')}</span>
          <span className="gg-phone-setup-field-purpose">{t('devices.phoneActions.host.purpose')}</span>
          {enabled && <span className="gg-phone-host-status" role="status">{statusText}</span>}
        </div>
        <Button size="sm" disabled={!!changing || unavailable} data-testid="phone-setup-enable-host" onClick={() => {
          if (failed) void changeHost('restart')
          else if (enabled) void changeHost('stop')
          else enable()
        }}>{changing ? t('devices.phoneActions.host.changing') : failed ? t('devices.phoneActions.host.restart') : enabled ? t('devices.phoneActions.host.stop') : t('devices.phoneActions.host.enable')}</Button>
      </div>
      {(error || hostError) && <SettingsNote tone="danger" role="alert">{error ?? hostError}</SettingsNote>}
    </div>
  )

  return (
    <SettingsGroup
      className="gg-phone-host-control"
      data-testid="phone-agent-host-settings"
      footer={error || hostError ? <SettingsNote tone="danger" role="alert">{error ?? hostError}</SettingsNote> : undefined}
    >
      <SettingsRow
        title={t('devices.phoneActions.host.tasks')}
        stack
        control={(
          <div className="flex flex-wrap items-center gap-2">
            {enabled || changing
              ? <Button size="sm" disabled={!!changing || unavailable} onClick={() => void changeHost('stop')}>{t('devices.phoneActions.host.stopHost')}</Button>
              : <Button size="sm" variant="primary" disabled={unavailable} onClick={enable}>{t('devices.phoneActions.host.enableHost')}</Button>}
            {failed && <Button size="sm" disabled={!!changing || unavailable} onClick={() => void changeHost('restart')}>{t('devices.phoneActions.host.restart')}</Button>}
          </div>
        )}
      >
        <div className="gg-phone-host-status" data-ready={!!ready && !changing && !error} role="status" data-testid="phone-host-status">{statusText}</div>
      </SettingsRow>
    </SettingsGroup>
  )
}
