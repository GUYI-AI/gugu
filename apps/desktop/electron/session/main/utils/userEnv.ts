import fs from 'node:fs';
import path from 'node:path';
import {
  agentBinDirsInPriorityOrder,
  vendorInstallDirs,
} from '@main/core/dependencies/managed-agent-home';
import { log } from '@main/lib/logger';
import type { LookupPathSource } from '@shared/core/agents/agent-payload';

/**
 * 解析 agent 时优先看这些目录。第一位是咕咕自己的安装目录 —— 它**不会**出现在用户登录
 * shell 的 PATH 里,所以必须由咕咕自己前置,否则「装进去了却找不到」。`~/.local/bin`
 * 留在后面:那是 codex 一类官方安装脚本的默认落点,用户机器上早就装好的副本仍要能被找到。
 *
 * 惰性求值:`GUGU_HOME` 是 main.ts 在启动早期才写进 env 的,模块求值期读会读到旧值。
 */
function userBinDirs(): string[] {
  return agentBinDirsInPriorityOrder();
}

function pathEntryExists(entry: string): boolean {
  try {
    return fs.statSync(entry).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 让 PATH 满足咕咕的解析优先级。
 *
 * `candidates[0]` 是**咕咕自己的**安装目录，它被**移到最前**——已经在 PATH 里也移动。
 * 其余候选是用户自己的目录，只在缺失时补上、已存在则原地不动：它们之间的先后是用户的
 * 偏好，咕咕不去重排。
 *
 * `trailing` 是各家官方安装器的标准落点（见 `vendorInstallDirs`），**追加在最末尾**。
 * 它解决的是「用户先照官网装好了、咕咕却说你没装」：发现靠的是 PATH，而 PATH 是用户环境里
 * 最不稳的东西。放最后 = 只让它被看见，不改变谁先被找到。
 *
 * 为什么第一项必须是"移动"而不是"不在就补"：`refreshUserPath()` 会把登录 shell 的
 * PATH 整体排到前面（每次检测都重读）。咕咕的目录那时已经在 PATH 里，
 * 若只判"存在就跳过"，它会留在末尾，被 `~/.local/bin` 里的旧副本重新遮住——正是 #4271
 * 那一幕：更新成功、版本不变。
 */
export function ensureUserBinDirsInPath(
  candidates: string[] = userBinDirs(),
  trailing: string[] = vendorInstallDirs()
): string[] {
  const currentPath = process.env.PATH ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);

  const [managed, ...userOwned] = candidates;
  const managedUsable = managed !== undefined && pathEntryExists(managed);
  const rest = managedUsable ? entries.filter((entry) => entry !== managed) : entries;
  const existing = new Set(rest);
  const additions = userOwned.filter(
    (candidate) => pathEntryExists(candidate) && !existing.has(candidate)
  );

  // 厂商安装器的标准落点**追加在最后**:只为「让原本看不见的那一份被发现」,
  // ❌ 不参与「谁先被找到」的排序 —— 前置会把用户自己 PATH 里那一份顶掉。
  const seenAfterHead = new Set([...additions, ...rest]);
  const appended = trailing.filter((candidate) => {
    if (seenAfterHead.has(candidate) || !pathEntryExists(candidate)) return false;
    seenAfterHead.add(candidate);
    return true;
  });

  const nextPath = [...(managedUsable ? [managed] : []), ...additions, ...rest, ...appended].join(
    path.delimiter
  );
  if (nextPath === currentPath) {
    return [];
  }

  process.env.PATH = nextPath;
  const managedWasAbsent = managedUsable && !entries.includes(managed);
  return managedWasAbsent
    ? [managed, ...additions, ...appended]
    : [...additions, ...appended];
}

// ---------------------------------------------------------------------------
// 用户当前 PATH 的重新读取（宿主注入）
// ---------------------------------------------------------------------------

type UserPathRefresher = () => Promise<LookupPathSource>;

let refresher: UserPathRefresher | undefined;
let lastPathSource: LookupPathSource | null = null;

/**
 * 宿主把 `refreshUserPath` 交进来。
 *
 * ❌ 不从这里直接 import `electron/shellPath`：会话页与宿主是两个 bundle，跨过去只会拿到
 * 复制品，而那个模块**有模块级状态**（`lastLoginShellPath`，报错时要靠它说明「当时 PATH 补
 * 没补上」）。复制品里的记录宿主永远读不到。
 */
export function setUserPathRefresher(fn: UserPathRefresher | undefined): void {
  refresher = fn;
}

/**
 * 每次检测前重新读一次用户**当前**的 PATH(macOS/Linux:登录 shell;Windows:注册表里的用户 + 系统 PATH)。
 *
 * 为什么:咕咕开着时用户在别的终端里 `npm i -g`、或者跑了一个往 rc / 用户 PATH 里加目录的安装器,
 * 新目录只在此刻的环境里;启动时那份快照看不见它,检测就一直报「未安装」,只能重启咕咕。
 * 读完把咕咕自己的目录重新排回最前(`ensureUserBinDirsInPath`,理由见它的注释)。
 *
 * 读不成不抛:PATH 保持上一次的值,来源里记下失败,由检测结果原样说给用户。没注入 = 宿主接线断了,出声。
 */
export async function refreshUserPath(): Promise<void> {
  if (!refresher) {
    log.warn('[userEnv] 宿主没有注入 PATH 重读实现 —— 这次检测用的还是启动时的 PATH。接线在 main.ts 的 setUserPathRefresher。');
    return;
  }
  lastPathSource = await refresher();
  ensureUserBinDirsInPath();
  if (lastPathSource.failed) log.warn(`[userEnv] 重新读取 PATH 失败(${lastPathSource.from}: ${lastPathSource.failed}),继续使用上一次的 PATH`);
}

/** 最近一次检测用的 PATH 从哪来;还没检测过则 null。 */
export function lookupPathSource(): LookupPathSource | null {
  return lastPathSource;
}

// ---------------------------------------------------------------------------
// 登录 shell 环境快照（宿主注入，#5873）
// ---------------------------------------------------------------------------

type LoginShellEnvProvider = () => Record<string, string> | null;

let loginShellEnvProvider: LoginShellEnvProvider | undefined;
let warnedMissingLoginShellEnvProvider = false;

/**
 * 宿主把 `loginShellEnvSnapshot` 交进来。
 *
 * ❌ 不从这里直接 import `electron/shellPath`：理由与 `setUserPathRefresher` 一字不差 ——
 * 会话页与宿主是两个 bundle，那个模块**有模块级状态**（快照本身就存在它的模块变量里），
 * 跨过去只会拿到一份永远是空的复制品，症状与不修一模一样（会话里还是没有用户的 key）。
 */
export function setLoginShellEnvProvider(fn: LoginShellEnvProvider | undefined): void {
  loginShellEnvProvider = fn;
}

/**
 * 用户登录 shell 的环境快照；Windows / 采样失败 / 宿主没接线时是 null。
 *
 * 返回 null **不是**错误路径的同义词：Windows 上本来就没有登录 shell，用户环境块由系统交给
 * GUI 进程，`buildUserShellBaseEnv` 在那边直接用 `process.env`。所以只在 POSIX 上出声，
 * 且只出一次 —— 这个函数每起一条会话都会被调用。
 */
export function loginShellEnv(): Record<string, string> | null {
  if (loginShellEnvProvider) return loginShellEnvProvider();
  if (process.platform !== 'win32' && !warnedMissingLoginShellEnvProvider) {
    warnedMissingLoginShellEnvProvider = true;
    log.warn(
      '[userEnv] 宿主没有注入登录 shell 环境快照 —— 用户写在 ~/.zshrc 里的 API key / 代理' +
        '这一轮到不了任何会话（症状：终端里跑得通、任务页里报 Missing environment variable）。' +
        '接线在 main.ts 的 setLoginShellEnvProvider。'
    );
  }
  return null;
}

