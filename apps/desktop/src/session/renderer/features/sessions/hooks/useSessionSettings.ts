import type { Reading } from '@/lib/replica';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import type { SessionSettings } from '@shared/core/app-settings';

export type NewTaskSettings = Pick<SessionSettings, 'autoGenerateName' | 'autoApproveByDefault' | 'includeIssueContextByDefault'>;

/**
 * The `sessions` fields the new-task flow starts from; the settings surface draws the reading itself (SessionSettingsRows).
 * Not read yet: the flow waits (it seeds its state once), ❌ starts from defaults; not readable: said, with `reload`.
 */
export function useSessionSettings(): { settings: Reading<NewTaskSettings>; reload: () => void } {
  const { settings, reload } = useAppSettingsKey('sessions');
  if (settings.state !== 'value') return { settings, reload };
  const { autoGenerateName, autoApproveByDefault, includeIssueContextByDefault } = settings.value.value;
  return { settings: { ...settings, value: { autoGenerateName, autoApproveByDefault, includeIssueContextByDefault } }, reload };
}
