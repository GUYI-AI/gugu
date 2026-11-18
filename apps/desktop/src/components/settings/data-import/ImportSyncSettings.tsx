import { Checkbox } from '@base-ui/react/checkbox'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { Check, X } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { notify } from '@/lib/notices'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { SettingsGroup, SettingsRow } from '../SettingsPrimitives'
import { importSettingsForOwner, updateImportSettings } from './import-sync-preferences'
import { cancelAutomaticImports } from './import-queue'
import { syncImports } from './import-sync'

export function ImportSyncSettings({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation('main')
  const { settings, refresh } = useAppSettingsKey('dataImport')
  if (settings.state !== 'value') {
    return (
      <SettingsGroup title={t('settings.dataImport.syncTitle')} className="gg-import-sync">
        <SettingsRow title={t('settings.dataImport.autoSync')}
          control={settings.state === 'error' ? (
            <Button variant="secondary" size="sm" onClick={() => { void refresh() }}>{t('settings.dataImport.refresh')}</Button>
          ) : <LoadingIndicator size="inline" />} />
      </SettingsGroup>
    )
  }
  const reading = importSettingsForOwner(settings.value.value, ownerId)
  return <ReadyImportSyncSettings ownerId={ownerId} reading={reading} />
}

function ReadyImportSyncSettings({ ownerId, reading }: {
  ownerId: string
  reading: ReturnType<typeof importSettingsForOwner>
}) {
  const { t } = useTranslation('main')
  const available = reading.sources.length > 0
  const [customizing, setCustomizing] = useState(false)
  const [sessions, setSessions] = useState(true)
  const [saving, setSaving] = useState(false)
  const change = async (enabled: boolean) => {
    setSaving(true)
    try {
      await updateImportSettings(ownerId, (before) => ({ ...before, automatic: enabled }))
      if (enabled) void syncImports(ownerId)
      else cancelAutomaticImports(ownerId)
    } catch {
      notify({ tier: 'error', title: t('settings.dataImport.syncSaveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsGroup title={t('settings.dataImport.syncTitle')} className="gg-import-sync">
      <SettingsRow title={t('settings.dataImport.autoSync')}
        description={available ? t('settings.dataImport.syncDescription') : t('settings.dataImport.syncPrerequisite')}
        control={<Switch aria-label={t('settings.dataImport.autoSync')} checked={reading.automatic}
          disabled={!available || saving} onCheckedChange={(value) => { void change(value) }} />} />
      <SettingsRow title={t('settings.dataImport.syncScope')} description={t('settings.dataImport.allScopes')}
        control={<Button variant="secondary" size="sm" disabled={!available} onClick={() => { setSessions(true); setCustomizing(true) }}>
          {t('settings.dataImport.customize')}
        </Button>} />
      {customizing && (
        <Sheet ariaLabel={t('settings.dataImport.chooseScope')} onClose={() => setCustomizing(false)}
          dimNested zIndex="var(--z-settings-modal)">
          <div className="gg-import-scope">
            <div className="gg-import-scope-header">
              <h3>{t('settings.dataImport.chooseScope')}</h3>
              <IconButton aria-label={t('settings.close')} onClick={() => setCustomizing(false)}><X size={16} /></IconButton>
            </div>
            {[t('settings.dataImport.scopeAll'), t('settings.dataImport.sessions')].map((label) => (
              <label key={label} className="gg-import-checkbox">
                <span>{label}</span>
                <Checkbox.Root checked={sessions} onCheckedChange={setSessions}>
                  <Checkbox.Indicator><Check size={12} /></Checkbox.Indicator>
                </Checkbox.Root>
              </label>
            ))}
            <div className="gg-import-scope-actions">
              <Button variant="secondary" size="sm" onClick={() => setCustomizing(false)}>{t('settings.dataImport.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={!sessions} onClick={() => setCustomizing(false)}>{t('settings.dataImport.save')}</Button>
            </div>
          </div>
        </Sheet>
      )}
    </SettingsGroup>
  )
}
