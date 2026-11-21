import { log } from '@main/lib/logger';
import { parseImportError } from '@shared/core/session-import/import-error-code';

/**
 * transcript 读取失败的错只带文件名（完整路径会原样出现在界面里），排查要的完整路径在这里补进日志。
 *
 * 路径取自**请求参数**而不是错误对象：预览在工作线程里跑，线程那头只递得回 message，
 * 错误对象上的 `filePath` 到不了这里。
 */
export async function logTranscriptFailure<T>(
  operation: 'preview' | 'import',
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const info = parseImportError(error instanceof Error ? error.message : '');
    if (info?.code.startsWith('transcript-')) {
      log.warn(`[session-import] ${operation} failed: ${info.code}`, { filePath });
    }
    throw error;
  }
}
