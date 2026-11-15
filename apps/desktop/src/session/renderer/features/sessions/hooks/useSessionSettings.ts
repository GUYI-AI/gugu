import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import type { SessionSettings } from '@shared/core/app-settings';

export type NewTaskSettings = Pick<SessionSettings, 'autoGenerateName' | 'autoApproveByDefault' | 'includeIssueContextByDefault'>;

/**
 * The `sessions` fields the new-task flow starts from; the settings surface draws the reading itself (SessionSettingsRows).
 * null = this device's settings are not read yet: the flow waits (it seeds its state once), ❌ starts from defaults.
 */
export function useSessionSettings(): NewTaskSettings | null {
  const { settings } = useAppSettingsKey('sessions');
  if (settings.state !== 'value') return null;
  const { autoGenerateName, autoApproveByDefault, includeIssueContextByDefault } = settings.value.value;
  return { autoGenerateName, autoApproveByDefault, includeIssueContextByDefault };
}
