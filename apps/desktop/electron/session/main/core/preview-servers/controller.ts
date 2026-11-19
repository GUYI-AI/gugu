import { createRPCController } from '@shared/lib/ipc/rpc';
import { previewServerService } from './preview-server-service-instance';

export const previewServersController = createRPCController({
  listForWorkspace: async (args: { workspaceId: string }) =>
    previewServerService.listForWorkspace(args),
});
