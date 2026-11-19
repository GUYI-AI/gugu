import { toast } from 'sonner';
import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import type { SessionTranslate } from '@renderer/features/extensions/extension-consent';

export function uninstallAgentWithToast(
  name: string,
  uninstall: () => Promise<void>,
  translate: SessionTranslate,
) {
  void toast.promise(uninstall(), {
    loading: translate('agentsPage.uninstalling', { name }),
    success: translate('agentsPage.uninstalled', { name }),
    error: (error) => {
      rendererLogger('actions/AgentSourceList').error({ error }, 'action failed');
      return messageForUser(error);
    },
  });
}
