import { parseImportError, type ImportErrorCode } from '@shared/core/session-import/import-error-code';
import type { Translate } from '@renderer/features/remote-hosts/connection-status';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

/** 码 → 词条。新增码时 `satisfies` 逼着这里补一条，词条两种语言都要有（词条表类型把关）。每条都是整句（不拼接）。 */
export const IMPORT_ERROR_COPY = {
  'transcript-unreadable': 'sessionImport.error.transcriptUnreadable',
  'transcript-outside-roots': 'sessionImport.error.transcriptOutsideRoots',
  'transcript-empty': 'sessionImport.error.transcriptEmpty',
  'transcript-no-identity': 'sessionImport.error.transcriptNoIdentity',
  'session-no-id': 'sessionImport.error.sessionNoId',
  'session-no-cwd': 'sessionImport.error.sessionNoCwd',
  'session-create-failed': 'sessionImport.error.sessionCreateFailed',
  'project-not-found': 'sessionImport.error.projectNotFound',
  'project-permission-denied': 'sessionImport.error.projectPermissionDenied',
  'project-not-git': 'sessionImport.error.projectNotGit',
  // 认不出的原因:界面只说通用一句,原始报错在主进程日志里。
  'project-open-failed': 'sessionImport.error.projectOpenFailed',
  'codex-import-unavailable': 'sessionImport.error.codexUnavailable',
  'codex-import-busy': 'sessionImport.error.codexBusy',
  'codex-import-selection-required': 'sessionImport.error.codexSelectionRequired',
  'codex-import-index-unreadable': 'sessionImport.error.codexIndexUnreadable',
  'codex-import-source-changed': 'sessionImport.error.codexSourceChanged',
  'codex-import-copy-changed': 'sessionImport.error.codexCopyChanged',
  'codex-import-task-failed': 'sessionImport.error.codexTaskFailed',
  'codex-import-source-unreadable': 'sessionImport.error.codexSourceUnreadable',
} as const satisfies Record<ImportErrorCode, SessionMessageLookupKey>;

/**
 * 本机 IPC 回到渲染层的 message 带着自定义错误的类名(真 Electron 实测:
 * `Error invoking remote method 'x': TranscriptAccessError: <码>:<名字>`),
 * `humanizeRpcError` 只剥外壳和 `Error:`,类名这一层在这里剥,否则码对不上、整句当原始诊断露出来。
 */
const ERROR_NAME_PREFIX = /^(?:[A-Za-z]*Error:\s*)+/;

/**
 * 主进程报的是原因码（`<码>:<文件名>`）→ 按当前语言说人话，名字只是文件名 / 文件夹名，完整路径从不进界面。
 * 认不出的 message（别的错、老版本机器发来的整句）原样返回，由调用方照旧当「原始诊断」说。
 */
export function localizeImportError(message: string, translate: Translate): string {
  return tryLocalizeImportError(message, translate) ?? message;
}

/** Settings can use their generic failure label for unknown diagnostics instead of exposing raw paths. */
export function tryLocalizeImportError(message: string, translate: Translate): string | null {
  const info = parseImportError(message.replace(ERROR_NAME_PREFIX, ''));
  if (!info) return null;
  return translate(IMPORT_ERROR_COPY[info.code], {
    name: info.name || translate('sessionImport.error.unnamedFile'),
  });
}
