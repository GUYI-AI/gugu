/**
 * 会话导入 / 预览失败的原因码。
 *
 * 主进程（和 core）只负责说「出了什么事」：抛一个 message 为 `<码>:<名字>` 的错，名字是文件名或目录名；
 * 界面按码查中英文案（`sessionImport.error.*`）。**完整路径不进 message** —— 它会原样出现在用户界面里，
 * 只写日志。
 *
 * 码放进 message 而不是错误对象的属性：本机 IPC 与预览线程都只递 message，属性到不了渲染层
 * （沿用 `gugu-models:<原因>` 同一种写法）。
 */
export const IMPORT_ERROR_CODES = [
  // core 的 TRANSCRIPT_ACCESS_CODES（单测核对这四条没漂）
  'transcript-unreadable',
  'transcript-outside-roots',
  'transcript-empty',
  'transcript-no-identity',
  // 导入时主进程自己报的
  'session-no-id',
  'session-no-cwd',
  'session-create-failed',
  // 项目落点（把会话所在的文件夹开成项目）失败：常见原因各一个码，认不出的归 project-open-failed（原始报错进日志）。
  'project-not-found',
  'project-permission-denied',
  'project-not-git',
  'project-open-failed',
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

const CODES: ReadonlySet<string> = new Set(IMPORT_ERROR_CODES);

/** `<码>:<名字>`。名字可空（`session-no-id:`）。 */
export function importErrorMessage(code: ImportErrorCode, name = ''): string {
  return `${code}:${name}`;
}

/** 带码的 Error：message 走线（IPC / 线程），`code` 留给同进程里的调用方。 */
export function importError(code: ImportErrorCode, name = ''): Error & { code: ImportErrorCode } {
  return Object.assign(new Error(importErrorMessage(code, name)), { code });
}

/**
 * 从**已剥掉 IPC 外壳**的 message 里读出码和名字；不是我们的码（别的错、老版本机器发来的中文句子）→ null，
 * 调用方照旧把原文当诊断说。锚在开头：句子中间碰巧出现 `xxx:` 不算。
 */
export function parseImportError(message: string): { code: ImportErrorCode; name: string } | null {
  const match = /^([a-z]+(?:-[a-z]+)+):([\s\S]*)$/.exec(message.trim());
  if (!match || !CODES.has(match[1])) return null;
  return { code: match[1] as ImportErrorCode, name: match[2].trim() };
}
