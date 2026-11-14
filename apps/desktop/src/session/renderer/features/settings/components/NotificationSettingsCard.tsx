import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { events, rpc } from '@renderer/lib/ipc';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { localizedManifestText } from '@shared/extensions/catalog';
import { messageForUser } from '@/lib/userFacingError';
import { Unknown } from '@/components/ui/Unknown';
import { readModel, useReadModel } from '@/lib/readModel';
import { SettingSwitch } from './SettingControls';
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives';

/** Per-App permissions this device's owner took back (the bridge reads the same grant on every call). */
const revokedPermissions = readModel({
  name: 'extensionRevokedPermissions',
  scope: 'device',
  read: async () => {
    const [, result] = await Promise.all([installedExtensionsStore.load(), rpc.extensions.revoked()]);
    if (!result.success || !result.data) throw new Error(result.error);
    return result.data;
  },
  persist: true,
});
events.on(extensionsInventoryChangedChannel, () => { void revokedPermissions.refresh(); });

const AppNotificationPermissions = observer(function AppNotificationPermissions() {
  const { translate } = useSessionMessages();
  const revoked = useReadModel(revokedPermissions, []);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const grant = async (extensionId: string, granted: boolean) => {
    setPending((now) => ({ ...now, [extensionId]: true }));
    try {
      // Same IPC as the App product page: the bridge reads this grant on every call.
      const result = await rpc.extensions.setPermissionGranted({ extensionId, permission: 'notifications', granted });
      if (!result.success || !result.data) throw new Error(result.error);
      revokedPermissions.set([], (now) => ({ ...now, [extensionId]: result.data!.revoked }));
      setError(null);
    } catch (cause) {
      setError(messageForUser(cause));
    } finally {
      setPending((now) => ({ ...now, [extensionId]: false }));
    }
  };
  const apps = installedExtensionsStore.manifests.filter((app) => app.permissions?.capabilities?.includes('notifications'));
  const readError = revoked.state === 'error' ? messageForUser(revoked.error) : null;
  if (apps.length === 0 && !error && !readError) return null;
  return <SettingsGroup title={translate('notifications.apps')}>
    {apps.map((app) => {
      const name = localizedManifestText(app, installedExtensionsStore.locale).name;
      return <SettingsRow key={app.id} title={name} control={revoked.state === 'value' ? <Switch
        aria-label={name}
        checked={!revoked.value[app.id]?.includes('notifications')}
        disabled={pending[app.id]}
        onCheckedChange={(checked) => { void grant(app.id, checked); }}
      /> : <Unknown className="h-5 w-8 flex-none rounded-[var(--radius-capsule)]" />} />;
    })}
    {(error ?? readError) && <SettingsNote tone="danger">{error ?? readError}</SettingsNote>}
  </SettingsGroup>;
});

export default function NotificationSettingsCard() {
  const notifications = useAppSettingsKey('notifications');
  const { translate } = useSessionMessages();
  const off = notifications.settings.state === 'value' && !notifications.settings.value.value.enabled;
  return <>
    <SettingsGroup>
      <SettingsRow title={translate('notifications.title')} description={translate('notifications.description')}
        control={<SettingSwitch api={notifications} field="enabled" resetLabel={translate('reset.on')} label={translate('notifications.title')} />} />
      <SettingsRow title={translate('notifications.sound')}
        control={<SettingSwitch api={notifications} field="sound" resetLabel={translate('reset.on')} label={translate('notifications.sound')} disabled={off} />} />
    </SettingsGroup>
    <AppNotificationPermissions />
  </>;
}
