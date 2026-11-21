import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import type { ChangesListViewMode, ChangesSection } from '@shared/core/app-settings';

/** `mode` null = not read yet (❌ assume flat). */
export function useChangesViewMode(section: ChangesSection) {
  const { settings, update } = useAppSettingsKey('changesViewMode');
  const mode: ChangesListViewMode | null = settings.state === 'value' ? settings.value.value[section] : null;
  const setMode = (next: ChangesListViewMode) => update({ [section]: next });
  return { mode, setMode };
}
