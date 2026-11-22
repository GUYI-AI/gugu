/**
 * #6264 咕咕 server 上会话里的程序要「打开网页」(`$BROWSER`,如 `gh auth login --web`、`vite --open`、
 * codex / claude 的登录回跳页):这台机器没有屏幕,照 VS Code 远端的做法 —— 会话的进程带着
 * `BROWSER=<助手脚本>`(server-browser-env.ts),脚本把网址经本机套接字交回来,再推到**正看着这条会话**的桌面
 * (server.cli.ts 的 openExternal),走 `session_open_in_tab` 同一条路由(remote-pane.ts,目标 `external`):
 * 那台桌面决定开进会话的浏览器格还是系统浏览器,网址里的 localhost 回调端口顺手经 SSH 转过去。
 *
 *  · 哪条会话:进程环境里的 `GUGU_TASK_ID`(只有会话的进程带)。没带 = 不属于任何会话(探针、安装器),不推给谁。
 *  · 网址只认 http / https;给的是文件(`$BROWSER report.html`)⇒ 只认这条会话工作目录里的文件,
 *    交给桌面的浏览器格渲染(与 open_in_tab 的 `file:` 网页同一道围栏)。
 */
import { isAbsoluteMachinePath } from '@main/core/files/path-utils';
import { canonicalPath, inWorkingCopy, type CanonicalPath } from '@gugu/session-core/files';
import { machinePathToFileUrl } from '@shared/preview/remote-page-url';
import type { SessionpagePaneTarget } from '@gugu/session-core/session-record/contract';
import { RemotePaneError, remotePaneQueuedNote, type RemotePaneRoute } from './remote-pane';

export { OPEN_EXTERNAL_CALL } from '../pty/attach/attach-protocol';

export type OpenExternalRequest = {
  /** 程序给的那个参数:网址,或一个文件路径。 */
  target: string;
  /** 助手脚本被调起时的当前目录(相对路径据它解析)。 */
  cwd: string;
  /** 进程环境里的 `GUGU_TASK_ID`(不属于任何会话 = 空)。 */
  sessionId: string;
};

export type OpenExternalReply =
  | { outcome: 'opened' }
  | { outcome: 'queued'; note: string };

export class OpenExternalError extends Error {
  constructor(
    readonly code: 'unsupported' | 'outside_workspace' | 'not_a_file' | 'no_session',
    message: string
  ) {
    super(message);
    this.name = 'OpenExternalError';
  }
}

export type OpenExternalDeps = {
  route: Pick<RemotePaneRoute, 'open'>;
  /** 这条会话的工作目录(没有这条会话 = null)。 */
  sessionRoot: (sessionId: string) => Promise<string | null>;
  /** 这个路径是不是一个文件。 */
  isFile: (path: string) => Promise<boolean>;
};

const HTTP_URL = /^https?:\/\//i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/** 参数 → 网址,或这台机器上的绝对路径(相对路径按 cwd 解析)。其余协议(mailto: 之类)不接。 */
export function classifyOpenTarget(raw: string, cwd: string): { url: string } | { path: string } {
  const value = raw.trim();
  if (HTTP_URL.test(value)) {
    try {
      return { url: new URL(value).toString() };
    } catch {
      throw new OpenExternalError('unsupported', `not a valid web address: ${value}`);
    }
  }
  if (value.toLowerCase().startsWith('file:')) {
    try {
      return { path: decodeURIComponent(new URL(value).pathname) };
    } catch {
      throw new OpenExternalError('unsupported', `not a valid file address: ${value}`);
    }
  }
  if (URL_SCHEME.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new OpenExternalError('unsupported', `only web pages (http / https) can be opened on your computer: ${value}`);
  }
  if (!value) throw new OpenExternalError('unsupported', 'nothing to open');
  if (isAbsoluteMachinePath(value)) return { path: value };
  return { path: `${trimSlash(cwd)}/${value.replace(/^\.\//, '')}` };
}

export async function openExternalFromMachine(request: OpenExternalRequest, deps: OpenExternalDeps): Promise<OpenExternalReply> {
  // The shell's folder and the file it names, in their one spelling (`@@@canonical-path`) — as the session roots are.
  const cwd = canonicalPath(request.cwd);
  const named = classifyOpenTarget(request.target, cwd);
  const classified: { url: string } | { path: CanonicalPath } = 'url' in named ? named : { path: canonicalPath(named.path) };
  const { sessionId } = request;

  let target: SessionpagePaneTarget;
  if ('url' in classified) {
    target = { kind: 'external', url: classified.url };
  } else {
    // 文件:只认会话工作目录里的(桌面的浏览器格经会话工作区的读文件动词取字节,围栏就是这个目录)。
    const found = sessionId ? await deps.sessionRoot(sessionId) : null;
    const root = found ? canonicalPath(found) : null;
    if (!root) {
      throw new OpenExternalError('no_session', `cannot tell which Gugu session this file belongs to: ${classified.path}`);
    }
    if (inWorkingCopy(root, classified.path) === null) {
      throw new OpenExternalError('outside_workspace', `only files inside the session folder (${root}) can be opened: ${classified.path}`);
    }
    if (!(await deps.isFile(classified.path))) {
      throw new OpenExternalError('not_a_file', `not a file: ${classified.path}`);
    }
    const url = machinePathToFileUrl(classified.path);
    if (!url) throw new OpenExternalError('not_a_file', `not a file: ${classified.path}`);
    target = { kind: 'browser', url };
  }

  const outcome = await deps.route.open(sessionId, target, 'pinned');
  return 'queued' in outcome ? { outcome: 'queued', note: remotePaneQueuedNote(outcome) } : { outcome: 'opened' };
}

/** 套接字那头的应答:成功 `{ result }`,失败 `{ error: { code, message } }`(message 是英文、给程序和人看的那一句)。 */
export async function answerOpenExternal(
  payload: unknown,
  deps: OpenExternalDeps
): Promise<{ result: OpenExternalReply } | { error: { code: string; message: string } }> {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const target = typeof body.target === 'string' ? body.target : '';
  const cwd = typeof body.cwd === 'string' && body.cwd.startsWith('/') ? body.cwd : '/';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  try {
    return { result: await openExternalFromMachine({ target, cwd, sessionId }, deps) };
  } catch (error) {
    if (error instanceof OpenExternalError || error instanceof RemotePaneError) {
      return { error: { code: error.code, message: error.message } };
    }
    return { error: { code: 'open_failed', message: error instanceof Error ? error.message : String(error) } };
  }
}
