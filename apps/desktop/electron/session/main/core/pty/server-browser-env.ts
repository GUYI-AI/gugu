/**
 * #6264 咕咕 server 上「打开网页」的唯一入口(照 VS Code 远端:server 给扩展宿主与终端设
 * `BROWSER=<server>/bin/helpers/browser.sh`,见 vscode src/vs/server/node/extensionHostConnection.ts)。
 *
 *  · `<GUGU_SERVER_HOME>/bin/gugu-browser <网址或文件>` —— 交给 `gugu-server open-url`,它经本机套接字问账号进程,
 *    账号进程推给正看着**这条会话**的桌面(remote-open-external.ts)。
 *  · 只有**会话**的进程(agent 的各条腿、会话里的终端与脚本)起的时候带上 `sessionBrowserEnv`:`BROWSER`、哪个账号、
 *    哪条会话(`GUGU_TASK_ID`,会话环境里本来就有的那一格)。探针、安装器这些不属于任何会话的进程不带,
 *    它们开的网页到不了任何人的桌面 —— 这由结构保证,不靠开关。
 *  · 不冒名 xdg-open:Node 的 `open` 包(自带的 xdg-open)、`vite --open`、gh、Python / Rust 的 webbrowser 都认 `$BROWSER`;
 *    直接 exec xdg-open 的程序在 server 上找不到它,自己把网址打印出来。
 *
 * 只在 server 模式装;桌面版本机的 agent 本来就在人眼前,`BROWSER` 不动。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { quoteShellArg } from '@main/utils/shellEscape';

export const BROWSER_HELPER = 'gugu-browser';
/** 旧版装过的冒名 xdg-open:启动时删掉(gugu-node 把这个目录放在 PATH 上)。 */
const RETIRED_XDG_OPEN = 'xdg-open';

type Helpers = { dir: string; account: string };
let helpers: Helpers | null = null;

export function setServerBrowserHelpers(next: Helpers | null): void {
  helpers = next;
}

/** `basePath` 的最前面放上 `dir`(已在里面就挪到最前)。咕咕写给 agent 的助手目录都这么上 PATH(这里与 gugu-node.ts)。 */
export function pathWithFirst(dir: string, basePath: string | undefined, delimiter: string = ':'): string {
  const parts = (basePath ?? '').split(delimiter).filter((part) => part && part !== dir);
  return [dir, ...parts].join(delimiter);
}

/** 会话的进程起的时候叠上去的那几格(不是 server = 空)。 */
export function sessionBrowserEnv(sessionId: string): Record<string, string> {
  if (!helpers) return {};
  return {
    BROWSER: path.join(helpers.dir, BROWSER_HELPER),
    GUGU_SERVER_ACCOUNT: helpers.account,
    GUGU_TASK_ID: sessionId,
  };
}

/** 叠到一份 spawn 环境上;不是 server 就原样返回(没有就还是没有)。 */
export function withSessionBrowserEnv(sessionId: string, env: Record<string, string> | undefined): Record<string, string> | undefined {
  return helpers ? { ...env, ...sessionBrowserEnv(sessionId) } : env;
}

/**
 * 脚本的正文。`launcher` = 起 `gugu-server` 的那几个词(装好的机器上是 `<home>/current/bin/gugu-server`,
 * 升级只切 current 软链,脚本不用重写;开发构建是 node + 入口脚本)。
 */
export function browserHelperScripts(launcher: readonly string[]): Record<string, string> {
  const run = launcher.map(quoteShellArg).join(' ');
  return {
    [BROWSER_HELPER]: [
      '#!/bin/sh',
      '# 咕咕 server:会话里的程序要打开网页时,转到正在看这条会话的咕咕桌面上打开(照 VS Code 远端的 $BROWSER)。',
      '# 由咕咕 server 生成,每次启动重写;改了也会被覆盖。',
      `exec ${run} open-url -- "$@"`,
      '',
    ].join('\n'),
  };
}

export type HelperFs = Pick<
  typeof fs,
  'mkdirSync' | 'writeFileSync' | 'chmodSync' | 'existsSync' | 'readFileSync' | 'renameSync' | 'rmSync'
>;

/**
 * 把助手脚本写进 `dir`(没有就建;只给自己读写执行),每次启动核一遍。这里的与 gugu-node.ts 的都这么写。
 *
 * 有人可能正在跑它(server 上几个账号进程共用这个目录,一个启动时另一个的 agent 正调着),所以 ❌ 原地截断重写:
 * 内容一样就不写;真变了,先写到旁边一个本进程独有的临时文件,再 rename 过去 —— 读的人看到的要么是旧的整份,要么是新的整份
 * (评审 729508060d:每次截断重写,竞速 130 次里 42 次失败,35 次 rc=0 却什么都没输出)。
 */
export function writeHelperScripts(dir: string, scripts: Record<string, string>, fsImpl: HelperFs = fs): void {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    if (sameContent(file, body, fsImpl)) {
      // 不碰内容,只把权限拉回来(被人改成 644 也修得回),对正在读它的人没有影响。
      fsImpl.chmodSync(file, 0o700);
      continue;
    }
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fsImpl.writeFileSync(temp, body, { mode: 0o700 });
      fsImpl.chmodSync(temp, 0o700);
      fsImpl.renameSync(temp, file);
    } catch (error) {
      // ❌ 在 PATH 上的目录里留一个可执行的半成品(Windows 上有人只读共享开着它时 rename 报 EPERM,chmod 也会失败)。
      // 删也删不掉(Windows 上 EBUSY)就算了:往外抛的要是原来那个错,❌ 让 rm 的错盖掉真正的原因。
      try {
        fsImpl.rmSync(temp, { force: true });
      } catch {
        // the original error is the one that says why
      }
      throw error;
    }
  }
}

/**
 * 读不出来(没有、EACCES、权限 000、读之前被删了)一律当「不一样」,改走临时文件 + rename:rename 只看目录可不可写,
 * 权限 000 的启动器也修得好。
 */
function sameContent(file: string, body: string, fsImpl: HelperFs): boolean {
  try {
    return fsImpl.readFileSync(file, 'utf8') === body;
  } catch {
    return false;
  }
}

/** 装上(每次启动重写一遍:升级后入口可能换了地方)并记下,之后起的会话进程都带上。返回脚本目录。 */
export function installServerBrowserHelpers(options: {
  serverHome: string;
  account: string;
  /** 开发构建的起法(没有 current/bin/gugu-server 时用)。 */
  fallbackLauncher: readonly string[];
  fsImpl?: HelperFs;
}): string {
  const fsImpl = options.fsImpl ?? fs;
  const dir = path.join(options.serverHome, 'bin');
  const installed = path.join(options.serverHome, 'current', 'bin', 'gugu-server');
  const launcher = fsImpl.existsSync(installed) ? [installed] : options.fallbackLauncher;
  writeHelperScripts(dir, browserHelperScripts(launcher), fsImpl);
  fsImpl.rmSync(path.join(dir, RETIRED_XDG_OPEN), { force: true });
  setServerBrowserHelpers({ dir, account: options.account });
  return dir;
}
