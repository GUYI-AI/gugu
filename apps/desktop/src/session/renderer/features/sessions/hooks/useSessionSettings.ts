import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy';

/** The `sessions` fields the new-task flow starts from; the settings surface draws the reading itself (SessionSettingsRows). */
export function useSessionSettings() {
  const { settings } = useAppSettingsKey('sessions');
  const sessions = settings.state === 'value' ? settings.value.value : undefined;
  return {
    autoGenerateName: sessions?.autoGenerateName ?? false,
    autoApproveByDefault: sessions?.autoApproveByDefault ?? DEFAULT_SESSION_AUTO_APPROVE,
    includeIssueContextByDefault: sessions?.includeIssueContextByDefault ?? true,
  };
}
