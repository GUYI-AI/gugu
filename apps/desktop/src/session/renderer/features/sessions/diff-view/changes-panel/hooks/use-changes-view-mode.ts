import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import type { ChangesListViewMode, ChangesSection } from '@shared/core/app-settings';

export function useChangesViewMode(section: ChangesSection) {
  const { settings, update } = useAppSettingsKey('changesViewMode');
  const mode: ChangesListViewMode = (settings.state === 'value' ? settings.value.value[section] : undefined) ?? 'flat';
  const setMode = (next: ChangesListViewMode) => update({ [section]: next });
  return { mode, setMode };
}
