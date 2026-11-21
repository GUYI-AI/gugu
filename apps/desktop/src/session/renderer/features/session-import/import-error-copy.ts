import { parseImportError, type ImportErrorCode } from '@shared/core/session-import/import-error-code';
import type { Translate } from '@renderer/features/remote-hosts/connection-status';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type ImportErrorCopy = {
  key: SessionMessageLookupKey;
  /** 有原因的句子：`key` 里留 `{reason}`，原因本身是另一条词条（同一句话套不同的原因）。 */
  reason?: SessionMessageLookupKey;
};

/** 码 → 词条。新增码时 `satisfies` 逼着这里补一条，词条两种语言都要有（词条表类型把关）。 */
export const IMPORT_ERROR_COPY = {
  'transcript-unreadable': { key: 'sessionImport.error.transcriptUnreadable' },
  'transcript-outside-roots': { key: 'sessionImport.error.transcriptOutsideRoots' },
  'transcript-empty': { key: 'sessionImport.error.transcriptEmpty' },
  'transcript-no-identity': { key: 'sessionImport.error.transcriptNoIdentity' },
  'session-no-id': { key: 'sessionImport.error.sessionNoId' },
  'session-no-cwd': { key: 'sessionImport.error.sessionNoCwd' },
  'session-create-failed': { key: 'sessionImport.error.sessionCreateFailed' },
  'project-not-found': { key: 'sessionImport.error.projectOpenFailedReason', reason: 'sessionImport.error.projectReasonNotFound' },
  'project-permission-denied': { key: 'sessionImport.error.projectOpenFailedReason', reason: 'sessionImport.error.projectReasonPermissionDenied' },
  'project-not-git': { key: 'sessionImport.error.projectOpenFailedReason', reason: 'sessionImport.error.projectReasonNotGit' },
  // 认不出的原因:界面只说通用一句,原始报错在主进程日志里。
  'project-open-failed': { key: 'sessionImport.error.projectOpenFailed' },
} as const satisfies Record<ImportErrorCode, ImportErrorCopy>;

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
  const info = parseImportError(message.replace(ERROR_NAME_PREFIX, ''));
  if (!info) return message;
  const copy: ImportErrorCopy = IMPORT_ERROR_COPY[info.code];
  return translate(copy.key, {
    name: info.name || translate('sessionImport.error.unnamedFile'),
    ...(copy.reason ? { reason: translate(copy.reason) } : {}),
  });
}
