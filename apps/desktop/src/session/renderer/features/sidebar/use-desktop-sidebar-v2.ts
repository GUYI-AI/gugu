import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';

/**
 * #2548 internal switch `interface.desktopSidebarV2` (off by default, no settings UI): the one-list desktop sidebar.
 * Not loaded yet reads as off.
 */
export function useDesktopSidebarV2Switch(): boolean {
  const { value } = useAppSettingsKey('interface');
  return value?.desktopSidebarV2 === true;
}
