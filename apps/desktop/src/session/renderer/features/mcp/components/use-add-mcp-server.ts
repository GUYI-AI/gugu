import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { useMcpLibrary } from './use-mcp-library';

export function useAddMcpServer(library: Pick<ReturnType<typeof useMcpLibrary>, 'servers' | 'harnessNames' | 'add'>) {
  const { translate } = useSessionMessages();
  const showServerModal = useShowModal('mcpServerModal');
  const onFailure = (error: unknown) => {
    log.error('MCP connector could not be added', { error: String(error) });
    toast({ title: translate('mcpLibrary.saveFailed'), description: messageForUser(error), variant: 'destructive' });
  };
  return async () => {
    try {
      showServerModal({
        existing: library.servers,
        harnessNames: await library.harnessNames(),
        onSuccess: (servers) => void library.add(servers.map((server) => ({ ...server, enabledByDefault: true }))).catch(onFailure),
      });
    } catch (error) {
      onFailure(error);
    }
  };
}
