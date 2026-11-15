import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat as lstatAsync, stat as statAsync } from 'node:fs/promises';
import path from 'node:path';
// `.ts` 扩展名:Codex ACP 桥(codex-app-server-acp.mjs)经 owned-child.ts 用 Node 原生的 TS 剥离直接加载这条链,
// 无扩展名的值导入在那边解析不到,桥当场 exit 1(类型导入会被擦掉,所以从前没事)。
import { readShimEnv, type WindowsShimReader } from './windows-node-entry.ts';

/**
 * Windows 上「已经解析出一个程序路径，现在要直接把它 spawn 起来」这件事的**唯一一份**做法。
 *
 * 为什么需要它：npm 在 Windows 上给全局包留下的入口不是可执行文件，而是一个 `.cmd` 批处理壳
 * （`<prefix>\codex.cmd`，真正的程序在旁边的 node_modules 里）。而 Node 自 18.20.2 / 20.12.2 起
 * （修 CVE-2024-27980）**禁止**不经 shell 直接执行 `.cmd` / `.bat` —— `spawn` 当场抛 `EINVAL`，
 * 而且是同步抛，连 `error` 事件都不给。
 *
 * 症状因此长得完全不像真因：文件明明躺在盘上，`<bin> --version` 却"跑失败了"，于是
 * 依赖探测判成 error、安装流程判成「安装后未检测到」—— 用户看到的是「命令跑完了，但还是找不到它」，
 * 然后去换镜像源、开关梯子、重启应用，一样都没用（#5719）。
 *
 * ❌ 不用 `shell: true` 代替：Node 在 Windows 上会把 file 与 args **不加引号**直接拼成命令行，
 * 路径里一个空格就散架（`C:\Program Files\...`）。这里自己拼、自己转义。
 *
 * 单可执行文件的 npm 壳（`"%dp0%\…\opencode.exe" %*`）不包 cmd.exe，直接起那个 exe：壳换不出来的才包。
 * 包了一层 cmd.exe 之后，`child.kill()` 只杀壳 ⇒ 要停它的拥有者用 `spawnOwnedChild`（owned-child.ts）。
 */

/** spawn / execFile 的 options 里需要一并带上的东西；不包壳时是空对象。 */
export type WindowsLauncherOverrides = {
  /** 命令行由我们自己拼好并转义完毕，Node 不要再插手。 */
  windowsVerbatimArguments?: true;
};

export type DirectSpawnPlan = {
  command: string;
  args: string[];
  spawnOverrides: WindowsLauncherOverrides;
  /** 包了 cmd.exe / powershell.exe：`child.pid` 是壳，真程序是它的孩子。 */
  wrapsShell: boolean;
  /** 跳过的壳本来会设的变量已叠上去的**完整**环境;spawn 用它代替调用方那份。没有要叠的就不给。 */
  env?: NodeJS.ProcessEnv;
};

/** Windows 的环境变量名不分大小写，`ComSpec` / `COMSPEC` / `comspec` 都得认。 */
function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

/**
 * cmd.exe 会先解析一次命令行，npm 风格的 `.cmd` 壳里那句 `%*` 再转发一次 —— 所以参数要按
 * **两层**转义，否则带空格或引号的参数在壳里就散了。这份算法沿用 cross-spawn，与
 * `codex-app-server-transport.ts` 共用同一份（那条路先踩出来的，#2808）。
 */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** 程序路径这一层：只过一次 cmd.exe 的解析。 */
export function escapeCmdCommand(input: string): string {
  return input.replace(CMD_META_CHARS, '^$1');
}

/** 参数这一层：先按 Windows argv 规矩引住，再过两遍 cmd.exe 的转义（壳里的 `%*` 是第二遍）。 */
export function escapeCmdShimArgument(input: string): string {
  let escaped = input.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META_CHARS, '^$1');
  return escaped.replace(CMD_META_CHARS, '^$1');
}

const PASSTHROUGH: WindowsLauncherOverrides = {};

/**
 * 把「跑这个程序」翻译成这台机器上真跑得起来的 argv。
 *
 * 非 Windows、以及 Windows 上的真可执行文件（`.exe` / 无扩展名）原样透传 —— 这条函数只在
 * 壳脚本上改变行为，别的什么都不动。
 */
export function planDirectSpawn(
  command: string,
  args: readonly string[] = [],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } & Omit<WindowsHandoffOptions, 'platform'> = {}
): DirectSpawnPlan {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return { command, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false };
  }

  const env = options.env ?? process.env;
  const extension = path.win32.extname(command).toLowerCase();
  const handoff = extension === '.cmd' || extension === '.ps1'
    ? resolveWindowsHandoffLaunch(command, { ...options, platform, env })
    : null;
  if (handoff) {
    const shimEnv = Object.keys(handoff.env).length > 0 ? { env: { ...env, ...handoff.env } } : {};
    return { command: handoff.program, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false, ...shimEnv };
  }

  if (extension === '.cmd' || extension === '.bat') {
    const commandLine = [escapeCmdCommand(command), ...args.map(escapeCmdShimArgument)].join(' ');
    return {
      command: windowsEnvValue(env, 'ComSpec') ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      spawnOverrides: { windowsVerbatimArguments: true },
      wrapsShell: true,
    };
  }

  if (extension === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      spawnOverrides: {},
      wrapsShell: true,
    };
  }

  return { command, args: [...args], spawnOverrides: PASSTHROUGH, wrapsShell: false };
}

// ── 在 PATH 上找程序 ─────────────────────────────────────────────────────────

/** 与 probe 的 `WHICH_TIMEOUT_MS` 同一个量级:PATH 里一个失效的网络盘,每次 stat 都要卡到 SMB 超时。 */
const WINDOWS_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Windows 上「这个命令在哪」的进程内做法,替代解析 `where` 的输出。
 *
 * `where` 按控制台代码页输出(中文系统是 GBK),而 exec 一律按 UTF-8 解码 ⇒ 路径里只要有一个
 * 非 ASCII 字符(中文用户名、`测试 目录`),拿回来的就是一串 `���� Ŀ¼`:依赖页「安装完成,但未检测到程序」,
 * 会话卡在 `--version` 的 spawn ENOENT。在这里直接按 PATH × PATHEXT 读盘,路径从头到尾是 Node 的字符串,
 * 没有解码这一步。
 *
 * 次序与 `where` 一致:先当前目录,再 PATH 各段;同一目录里先原名(带扩展名时),再按 PATHEXT 的次序。
 * 带路径的命令(`C:\x\codex.cmd`)只在它那个目录里找 —— `where dir:pattern` 的语义。
 * 命令里的 `%VAR%` 按 env 展开(厂商固定安装位置 `%LOCALAPPDATA%\…`);有一个展不开 = 没有,❌ 拿字面量去碰。
 * 不带扩展名的同名文件(npm 给 POSIX 留的那份壳)不算:Windows 跑不了它。
 */
export async function findWindowsCommandPaths(
  command: string,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    isFile?: (candidate: string) => Promise<boolean> | boolean;
    isDirectory?: (candidate: string) => Promise<boolean> | boolean;
    /** 整次查找的上限;到点返回 null,调用方退回 `where`(它跑在带超时的子进程里)。 */
    timeoutMs?: number;
  } = {}
): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs ?? WINDOWS_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([searchWindowsCommandPaths(command, options), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function searchWindowsCommandPaths(
  command: string,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    isFile?: (candidate: string) => Promise<boolean> | boolean;
    isDirectory?: (candidate: string) => Promise<boolean> | boolean;
  }
): Promise<string[]> {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsFile;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const cwd = options.cwd ?? process.cwd();
  let unresolved = false;
  command = command.replace(/%([^%\r\n]+)%/g, (literal, name: string) => {
    const value = windowsEnvValue(env, name);
    if (value === undefined) unresolved = true;
    return value ?? literal;
  });
  if (unresolved) return [];
  const separator = Math.max(command.lastIndexOf('\\'), command.lastIndexOf('/'));
  const name = command.slice(separator + 1);
  if (!name) return [];
  const directories = separator >= 0
    ? [command.slice(0, separator + 1)]
    : [cwd, ...(windowsEnvValue(env, 'PATH') ?? '').split(';')];
  const extensions = (windowsEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'));
  const names = [...(path.win32.extname(name) ? [name] : []), ...extensions.map((extension) => name + extension)];

  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of directories) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!entry) continue;
    // 相对的 PATH 段 / `.\bin\x`:按这次查找的 cwd 解析(`where` 跑在 exec 的 cwd 里,打印绝对路径)。
    const directory = path.win32.resolve(cwd, entry);
    // 每个目录先看一次在不在:不在(或是失效的盘)就整段跳过,❌ 对它逐个扩展名再 stat 十几次。
    if (!(await isDirectory(directory))) continue;
    for (const candidate of names) {
      const full = path.win32.join(directory, candidate);
      const key = full.toLowerCase();
      if (seen.has(key) || !(await isFile(full))) continue;
      seen.add(key);
      found.push(full);
    }
  }
  return found;
}

async function defaultIsDirectory(candidate: string): Promise<boolean> {
  try {
    return (await statAsync(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 「不是目录」就算:WindowsApps 下的 App Execution Alias(Store / MSIX 装的 CLI,0 字节的 APPEXECLINK 重解析点)
 * `stat` 跟不过去会抛错或报不出普通文件,而 `where` 列它、CreateProcess 也跑得动 ⇒ 抛错时退到 `lstat` 看链接本身。
 * 异步:PATH 里一个失效的网络盘会让每次 stat 卡到 SMB 超时,不能卡在主线程上。
 */
async function defaultIsFile(candidate: string): Promise<boolean> {
  try {
    return !(await statAsync(candidate)).isDirectory();
  } catch (error) {
    // 根本不在(含断掉的符号链接)就是不在;只有「在、但 stat 跟不过去」的(APPEXECLINK)才看链接本身。
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    try {
      return !(await lstatAsync(candidate)).isDirectory();
    } catch {
      return false;
    }
  }
}

// ── 交给别人的进程去 spawn 的那条路径 ──────────────────────────────────────────

/**
 * 上面 `planDirectSpawn` 解决的是「**我们自己**怎么把这个壳跑起来」。
 * 这一节解决的是另一半:**路径要交给别人的进程去 spawn**,而那边不会替我们包壳。
 *
 * 现场(2026-09-18 Windows 真机):咕咕把 `ctx.cli` 放进 `CLAUDE_CODE_EXECUTABLE`,交给
 * 厂商的 ACP 适配器(`@agentclientprotocol/claude-agent-acp`)+ Claude Agent SDK。
 * npm 在 Windows 上留下的入口是 `claude.cmd`,SDK 直接 `spawn` 它 —— Node 自
 * 18.20.2 / 20.12.2 起(修 CVE-2024-27980)禁止不经 shell 执行 `.cmd`,于是
 * `session/new` 回的是 `{"code":-32603,"message":"Internal error","data":{"details":"spawn EINVAL"}}`。
 *
 * ⇒ 用户看到的不是「起不来」,而是**整档模型消失**:模型目录靠这条 `session/new` 探,
 *    探失败 ⇒ 「你的 Claude Code 模型」那一组连同它下面的登录入口一起不渲染,
 *    下拉里只剩咕咕代付的那一档。真因与症状之间隔着三层。
 *
 * ❌ 不能用 `shell: true` 或包一层 `cmd.exe` 补救:那两样都得由**真正 spawn 的那一方**做,
 *    而那一方是别人的代码。我们能给的只有一条路径 ⇒ 那条路径必须自己就能被 spawn。
 *
 * 好在 npm 的 `.cmd` 壳里写着它到底要跑什么。`@anthropic-ai/claude-code` 这类**原生**包的壳
 * 就是一行 `"%dp0%\node_modules\…\claude.exe"   %*` —— 把它读出来即可。
 * 壳里要跑的不是单个可执行文件(例如 `node "%dp0%\…\cli.js" %*`)时返回 null:
 * 那种情况没有「一条能交出去的路径」,**由调用方响亮失败**,❌ 不猜一个。
 */

/** Windows 上 Node 能直接 spawn 的东西:真可执行文件(或无扩展名的那种)。 */
function isDirectlySpawnableOnWindows(command: string): boolean {
  const extension = path.win32.extname(command).toLowerCase();
  return extension === '' || extension === '.exe' || extension === '.com';
}

/**
 * npm cmd-shim 里那一行「跑这一个程序,把参数原样转发」。
 * 必须是**整行只有这一个程序 + `%*`**:`node "…\cli.js" %*` 那种多一个参数的不匹配 ——
 * 匹配上就会把 `node.exe` 当成目标,丢掉真正要跑的那个脚本。
 */
const CMD_SHIM_SINGLE_PROGRAM = /^\s*@?"([^"\r\n]+\.(?:exe|com))"\s+%\*\s*$/im;

/** 壳里的 `%dp0%` / `%~dp0` = 壳自己所在目录(带尾分隔符)。 */
function expandShimDirectory(template: string, shimPath: string): string {
  const directory = path.win32.dirname(shimPath);
  const expanded = template.replace(/%~dp0|%dp0%/gi, `${directory}\\`);
  // `"%dp0%\node_modules\…"` 展开后会多出一个分隔符;Windows 认,但路径比对不认。
  return expanded.replace(/(?<!^)\\{2,}/g, '\\');
}

export type WindowsHandoffOptions = {
  platform?: NodeJS.Platform;
  /** 读壳脚本;读不到返回 null。抽出来是为了让判据不依赖真实文件系统。 */
  readShim?: (shimPath: string) => string | null;
  /** 目标是否真的存在。 */
  exists?: (candidate: string) => boolean;
  /** 程序将要拿到的环境:壳里 `%VAR%` 按它展开。默认本进程的。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 壳的 SET 读不全时:默认 null(调用方照旧起壳,设置一个不丢);`'drop'` = 仍交出程序、不带那份设置 ——
   * 只给没有壳可退的调用方(Claude 的 ACP 适配器:不交出程序就起不来)。
   */
  unreadableEnv?: 'drop';
};

/** 绕过壳直接起的那个程序,以及壳本来会给它设的环境(叠在 spawn env 最上面;壳里的 SET 本来就最后执行)。 */
export type WindowsHandoffLaunch = { program: string; env: Record<string, string> };

/**
 * 把一条**要交给别的进程去 spawn** 的路径,翻译成那边真 spawn 得起来的程序 + 它要带上的环境。
 * 翻译不出来时返回 null —— 调用方据此响亮失败或照旧起壳,❌ 不静默回落。
 *
 * 壳在调程序前设的变量(用户自己写的 `set CODEX_HOME=…` / `set "PATH=C:\\tools;%PATH%"`)随 `env` 一起交出:
 * 直接起程序却丢了它们,程序就悄悄换了一套配置与登录。设得读不全(条件分支、展不开的 `%VAR%`)⇒ null。
 */
export function resolveWindowsHandoffLaunch(
  command: string,
  options: WindowsHandoffOptions = {}
): WindowsHandoffLaunch | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || isDirectlySpawnableOnWindows(command)) return { program: command, env: {} };

  const extension = path.win32.extname(command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat' && extension !== '.ps1') return null;

  // npm 三个壳(`name` / `name.cmd` / `name.ps1`)是一起写下的,`.cmd` 那份格式最稳:`.ps1` 读它;`.bat` 读自己。
  const shimPath = extension === '.cmd' || extension === '.bat'
    ? command
    : `${command.slice(0, command.length - extension.length)}.cmd`;

  const readShim = options.readShim ?? defaultReadShim;
  const text = readShim(shimPath);
  if (!text) return null;

  const match = CMD_SHIM_SINGLE_PROGRAM.exec(text);
  if (!match) return null;
  // 只读程序行之前的:之后的(`if errorlevel 1 pause`、`set RC=%ERRORLEVEL%`)在程序退出后才执行,与它无关。
  const env = readShimEnv(text.slice(0, match.index), shimPath, options.env ?? process.env)
    ?? (options.unreadableEnv === 'drop' ? {} : null);
  if (!env) return null;

  const target = expandShimDirectory(match[1]!, shimPath);
  const exists = options.exists ?? defaultExists;
  return exists(target) ? { program: target, env } : null;
}

// ── 交给 node 去跑的那条路径 ──────────────────────────────────────────────────

/**
 * 真读盘的壳读取器,交给 `resolveWindowsNodeScriptEntry`(`windows-node-entry.ts`)用(#6390)。
 * 那个解析函数住在不带 `node:` 导入的模块里 —— 它经 agents/plugins 的 barrel 进了 web 构建;
 * 读盘这一半只由 node 侧的宿主(Electron 主进程、worker 的 boot)注入。
 */
export const diskWindowsShimReader: WindowsShimReader = {
  readShim: (shimPath) => defaultReadShim(shimPath),
  exists: (candidate) => defaultExists(candidate),
};

/**
 * 一个可执行文件此刻的「身份」:这条路径此刻指着的真实文件(跟随符号链接)+ 那份文件的 mtime + size。
 * 就地升级路径不变而文件换了:原生安装器改软链接指向 ⇒ 真实文件变;npm / brew 原地覆盖 ⇒ mtime 变。
 * 并进键里的缓存因此换了那份文件就查不中 —— 版本探针(`resolveSessionRuntimeCompatible` 的 `fileStamp`)
 * 与模型目录的输入指纹(`resolveHarnessSpawnIdentity`,#7081)。只 stat,不起进程。读不到就是 null。
 */
export function diskFileStamp(file: string): string | null {
  try {
    const real = realpathSync(file);
    const stat = statSync(real);
    return `${real}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function defaultReadShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
}

function defaultExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}
