import type { EnvironmentImportCategory, EnvironmentImportRequest } from '@shared/core/session-import/environment-import';
import { scanEnvironmentImport, importEnvironmentCategory, cancelEnvironmentImport } from '../environment-import/controller-service';
import type { ImportCodexTaskParams } from '@shared/core/session-import/codex-tasks';
import { scanCodexTaskImport, importCodexTasks, cancelCodexTaskImport, codexTaskImportProgress } from './codex-tasks';
import type {
  ImportLocalSessionParams,
  ListLocalSessionsParams,
  PreviewLocalSessionParams,
} from '@shared/core/session-import/session-import';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { hasLocalSessionSource, getLocalSessionSource } from './host-source';
import { importLocalSession } from './import-local-session';
import { logTranscriptFailure } from './transcript-failure-log';

export const sessionImportController = createRPCController({
  scanEnvironmentImport: (category: Exclude<EnvironmentImportCategory, 'tasks'>) => scanEnvironmentImport(category),
  importEnvironmentCategory: (request: EnvironmentImportRequest) => importEnvironmentCategory(request),
  cancelEnvironmentImport: async (id: string) => { cancelEnvironmentImport(id); },
  scanCodexTasks: () => scanCodexTaskImport(),
  importCodexTasks: (params: ImportCodexTaskParams[]) => importCodexTasks(params),
  cancelCodexTaskImport: async () => { cancelCodexTaskImport(); },
  codexTaskImportProgress: async () => codexTaskImportProgress(),
  /** 本机能不能导入会话（web / 未接线的宿主上为 false，入口据此隐藏而不是点了才报错）。 */
  isAvailable: () => Promise.resolve(hasLocalSessionSource()),
  listLocalSessions: (params: ListLocalSessionsParams) => getLocalSessionSource().list(params),
  previewLocalSession: (params: PreviewLocalSessionParams) =>
    logTranscriptFailure('preview', params.filePath, () => getLocalSessionSource().preview(params)),
  importLocalSession: (params: ImportLocalSessionParams) =>
    logTranscriptFailure('import', params.filePath, () => importLocalSession(params)),
});
