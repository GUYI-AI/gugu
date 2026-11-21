import type { ImportErrorCode } from '@shared/core/session-import/import-error-code';

export type ProjectFailureCode = Extract<ImportErrorCode, `project-${string}`>;

/**
 * 「把会话所在的文件夹开成项目」失败的原因归类。失败来自三处，各有各的形状：
 *  · `createLocalProject` 的 `{ type, message }`（`invalid-directory` / `inspect-failed` / `open-repository-failed` ……）；
 *  · `openProject` 的 `path-not-found` / `path-access-blocked`（macOS 权限弹窗未答，#3611）/ `error`；
 *  · 其中 `message` 是 fs 的 errno 原话（`ENOENT: no such file or directory, …`、`EACCES: permission denied, …`）
 *    或 git 的 stderr（`LC_ALL=C` 下固定英文：`fatal: not a git repository …`、
 *    `fatal: cannot change to '<dir>': Permission denied` / `No such file or directory`）。
 *
 * 只认实测过的几种原话；认不出的一律 `project-open-failed`（界面说通用一句，原始报错由调用方写日志）。
 */
const PERMISSION = /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted/i;
const NOT_FOUND = /\b(?:ENOENT|ENOTDIR)\b|no such file or directory|not a directory/i;
const NOT_GIT = /not a git repository/i;

export function projectFailureCode(failure: { type: string; message?: string }): ProjectFailureCode {
  const text = failure.message ?? '';
  if (failure.type === 'path-access-blocked' || PERMISSION.test(text)) return 'project-permission-denied';
  if (failure.type === 'path-not-found' || failure.type === 'invalid-directory' || NOT_FOUND.test(text)) return 'project-not-found';
  if (failure.type === 'not-repository' || NOT_GIT.test(text)) return 'project-not-git';
  return 'project-open-failed';
}
