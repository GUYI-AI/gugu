import { notify } from '@/lib/notices';
import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import type { SessionTranslate } from '@renderer/features/extensions/extension-consent';

export function uninstallAgentWithToast(
  name: string,
  uninstall: () => Promise<void>,
  translate: SessionTranslate,
) {
  // One notice for the whole uninstall: waiting, then its result in place.
  const key = `agent-uninstall:${name}`;
  notify({ key, title: translate('agentsPage.uninstalling', { name }), waiting: true, ongoing: true });
  void uninstall().then(
    () => notify({ key, title: translate('agentsPage.uninstalled', { name }), tier: 'success' }),
    (error: unknown) => {
      rendererLogger('actions/AgentSourceList').error({ error }, 'action failed');
      notify({ key, title: messageForUser(error), tier: 'error' });
    },
  );
}
