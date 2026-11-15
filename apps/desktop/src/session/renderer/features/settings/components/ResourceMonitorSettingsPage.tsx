import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { Switch } from '@/components/ui/Switch';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { openResourcePopup } from './resource-monitor-host';
import { SettingValue } from './SettingControls';
import { ResourceTimeline } from './resource-timeline';

export const ResourceMonitorSettingsPage = observer(function ResourceMonitorSettingsPage() {
  const { settings, update, isSaving } = useAppSettingsKey('resourceMonitor');
  const { translate } = useSessionMessages();
  const value = settings.state === 'value' ? settings.value.value : null;
  const enabled = value?.enabled === true;
  const store = appState.resourceMonitor;

  useEffect(() => {
    if (!enabled) return;
    const release = store.watch();
    return () => { void store.setInternals(false); release(); };
  }, [enabled, store]);

  return (
    <SettingsPage>
      <SettingsRow
        title={translate('resourceMonitor.enabled')}
        description={translate('resourceMonitor.description')}
        control={<SettingValue reading={settings} placeholder="h-5 w-8 rounded-[var(--radius-capsule)]">
          {({ value: { enabled: on } }) => <Switch aria-label={translate('resourceMonitor.enabled')} checked={on} disabled={isSaving} onCheckedChange={(next) => update({ enabled: next })} />}
        </SettingValue>}
      />
      {value?.enabled && <SettingsRow
        title={translate('resourceMonitor.pageCounters')}
        description={translate('resourceMonitor.pageCountersDescription')}
        control={<Switch aria-label={translate('resourceMonitor.pageCounters')} checked={value.pageCounters} disabled={isSaving} onCheckedChange={(next) => update({ pageCounters: next })} />}
      />}
      {value?.enabled === false && <SettingsNote>{translate('resourceMonitor.off')}</SettingsNote>}
      <ResourceTimeline live={enabled} onFloat={enabled ? openResourcePopup : undefined} />
    </SettingsPage>
  );
});
