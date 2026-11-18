import { observer } from 'mobx-react-lite';
import { SettingsNote, SettingsPage } from '@/components/settings/SettingsPrimitives';
import { LibraryHostProvider } from '@renderer/features/library/library-host';
import { RoutedIntegrationsLibraryPage } from '@renderer/features/library/routed-integrations-library-page';
import { useSelectedLibraryHost } from '@renderer/features/library/use-selected-library-host';
import { McpLibraryView } from '@renderer/features/mcp/components/McpLibraryView';
import { DeviceScopePicker, DeviceScopeProvider, DeviceScopeStatus } from '@renderer/features/remote-hosts/device-scope-picker';
import { libraryDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const DesktopConnectionsSettings = observer(function DesktopConnectionsSettings() {
  const host = useSelectedLibraryHost();
  const { translate } = useSessionMessages();
  return (
    <SettingsPage data-testid="desktop-connected-apps">
      <SettingsNote>{translate('settings.desktopConnectionsDescription')}</SettingsNote>
      <div className="flex items-center gap-2">
        <DeviceScopePicker store={libraryDeviceStore} variant="sidebar" />
        <DeviceScopeStatus store={libraryDeviceStore} />
      </div>
      <DeviceScopeProvider store={libraryDeviceStore} inTitle={false}>
        <LibraryHostProvider value={host} key={host.key}>
          <RoutedIntegrationsLibraryPage host={host} inSettings />
          <McpLibraryView inSettings />
        </LibraryHostProvider>
      </DeviceScopeProvider>
    </SettingsPage>
  );
});
