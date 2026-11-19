import { createRPCController } from '@shared/lib/ipc/rpc';
import { editorBufferService } from './editor-buffer-service';

export const editorBufferController = createRPCController({
  saveBuffer: (workspaceId: string, filePath: string, content: string) =>
    editorBufferService.saveBuffer(workspaceId, filePath, content),

  clearBuffer: (workspaceId: string, filePath: string) =>
    editorBufferService.clearBuffer(workspaceId, filePath),

  listBuffers: (workspaceId: string) =>
    editorBufferService.listBuffers(workspaceId),
});
