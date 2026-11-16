import { useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { events, rpc } from '@renderer/lib/ipc';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LOCAL_HOST, useInstalledApps } from '@renderer/features/extensions/installed-extensions';
import { extensionsApiOf } from '@renderer/features/extensions/extensions-api';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { localizedManifestText } from '@shared/extensions/catalog';
import { messageForUser } from '@/lib/userFacingError';
import { Unknown } from '@/components/ui/Unknown';
import { replica, useReplica } from '@/lib/replica';
import { SettingSwitch } from './SettingControls';
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives';

/** Per-App permissions a host's owner took back; only this desktop's is kept. */
export const revokedPermissions = replica({
  name: 'extensionRevokedPermissions',
  scope: 'device',
  read: async (_owner: string, hostKey: string) => {
    const result = await extensionsApiOf(hostKey).revoked();
    if (!result.success || !result.data) throw new Error(result.error);
    return result.data;
  },
  persist: { maxBytes: 1024, maxEntries: 1, carry: (value: Record<string, string[]>, hostKey: string) => (hostKey === LOCAL_HOST ? value : undefined) },
});
events.on(extensionsInventoryChangedChannel, () => { void revokedPermissions.refresh(LOCAL_HOST); });

function AppNotificationPermissions() {
  const { translate } = useSessionMessages();
  const revoked = useReplica(revokedPermissions, [LOCAL_HOST]);
  const installed = useInstalledApps(LOCAL_HOST);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const grant = async (extensionId: string, granted: boolean) => {
    setPending((now) => ({ ...now, [extensionId]: true }));
    try {
      // Same IPC as the App product page: the bridge reads this grant on every call.
      const result = await rpc.extensions.setPermissionGranted({ extensionId, permission: 'notifications', granted });
      if (!result.success || !result.data) throw new Error(result.error);
      revokedPermissions.at(LOCAL_HOST).set((now) => ({ ...now, [extensionId]: result.data!.revoked }));
      setError(null);
    } catch (cause) {
      setError(messageForUser(cause));
    } finally {
      setPending((now) => ({ ...now, [extensionId]: false }));
    }
  };
  const readError = revoked.state === 'error' ? messageForUser(revoked.error) : installed.state === 'error' ? messageForUser(installed.error) : null;
  // What is installed not known yet: one row's placeholder under the heading (❌ the section absent, then inserted).
  if (installed.state === 'unknown') {
    return <SettingsGroup title={translate('notifications.apps')}>
      <SettingsRow title={<Unknown className="w-24" />} control={<Unknown className="h-5 w-8 flex-none rounded-[var(--radius-capsule)]" />} />
    </SettingsGroup>;
  }
  const listed = installed.state === 'value' ? installed.value : null;
  const apps = listed ? listed.manifests.filter((app) => app.permissions?.capabilities?.includes('notifications')) : null;
  if (apps !== null && apps.length === 0 && !error && !readError) return null;
  return <SettingsGroup title={translate('notifications.apps')}>
    {apps?.map((app) => {
      const name = localizedManifestText(app, listed!.locale).name;
      return <SettingsRow key={app.id} title={name} control={revoked.state === 'value' ? <Switch
        aria-label={name}
        checked={!revoked.value[app.id]?.includes('notifications')}
        disabled={pending[app.id]}
        onCheckedChange={(checked) => { void grant(app.id, checked); }}
      /> : <Unknown className="h-5 w-8 flex-none rounded-[var(--radius-capsule)]" />} />;
    })}
    {(error ?? readError) && <SettingsNote tone="danger">{error ?? readError}</SettingsNote>}
  </SettingsGroup>;
}

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
