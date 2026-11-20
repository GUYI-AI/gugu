import { ENVIRONMENT_IMPORT_CATEGORIES, type EnvironmentImportCategory } from '@shared/core/session-import/environment-import'
import { categoryLabelKey } from './environment-import-view'
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
  const [categories, setCategories] = useState<EnvironmentImportCategory[]>([...ENVIRONMENT_IMPORT_CATEGORIES])
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
      <SettingsRow title={t('settings.dataImport.syncScope')} description={(reading.categories ?? ['tasks']).length < ENVIRONMENT_IMPORT_CATEGORIES.length ? t('settings.dataImport.selectedScopes', { count: (reading.categories ?? ['tasks']).length }) : t('settings.dataImport.scopeCategories')}
        control={<Button variant="secondary" size="sm" disabled={!available} onClick={() => { setCategories([...(reading.categories ?? ['tasks'])]); setCustomizing(true) }}>
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
            {(['all', ...ENVIRONMENT_IMPORT_CATEGORIES] as const).map((category) => (
              <label key={category} className="gg-import-checkbox">
                <span>{category === 'all' ? t('settings.dataImport.scopeAll') : t(categoryLabelKey(category))}</span>
                <Checkbox.Root checked={category === 'all' ? categories.length === ENVIRONMENT_IMPORT_CATEGORIES.length : categories.includes(category)}
                  onCheckedChange={checked => setCategories(before => category === 'all' ? checked ? [...ENVIRONMENT_IMPORT_CATEGORIES] : []
                    : checked ? [...new Set([...before, category])] : before.filter(item => item !== category))}>
                  <Checkbox.Indicator><Check size={12} /></Checkbox.Indicator>
                </Checkbox.Root>
              </label>
            ))}
            <div className="gg-import-scope-actions">
              <Button variant="secondary" size="sm" onClick={() => setCustomizing(false)}>{t('settings.dataImport.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={!categories.length || saving} onClick={() => {
                setSaving(true)
                void updateImportSettings(ownerId, before => ({ ...before, categories })).then(() => { cancelAutomaticImports(ownerId, categories); setCustomizing(false) })
                  .catch(() => notify({ tier: 'error', title: t('settings.dataImport.syncSaveFailed') })).finally(() => setSaving(false))
              }}>{t('settings.dataImport.save')}</Button>
            </div>
          </div>
        </Sheet>
      )}
    </SettingsGroup>
  )
}
