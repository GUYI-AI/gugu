import { scanCodexTasks, verifyCodexTaskFiles } from './codex-task-source';
import type { CodexTaskSourceRow } from '@shared/core/session-import/codex-tasks';

process.once('disconnect', () => process.exit(0));
process.once('message', (request: { sourceRoot: string; verify?: CodexTaskSourceRow[] }) => {
  void (request.verify ? verifyCodexTaskFiles(request.sourceRoot, request.verify).then(() => ({ verified: true })) : scanCodexTasks(request.sourceRoot)).then(
    result => process.send?.(result, () => process.disconnect()),
    () => process.exit(1),
  );
});
