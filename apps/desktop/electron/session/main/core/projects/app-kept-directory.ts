import { homedir } from 'node:os';
import { canonicalPath, placeUnder, type CanonicalPath } from '@gugu/session-core/files';
import { resolveGuguHome } from '@gugu/core/local/state/paths';

/** taskHome: 任务工作区本身靠固定 id 认(isImplicitSessionHomeProjectId),这里只在调用方给了时才看它。 */
export type AppKeptDirectories = { home: string; guguHome: string; taskHome?: string };

function currentDirectories(): AppKeptDirectories {
  return { home: homedir(), guguHome: resolveGuguHome() };
}

const inside = (child: CanonicalPath, parent: CanonicalPath) => placeUnder(parent, child) !== null;

/**
 * #609 一个目录是不是「咕咕自己要用的」:这台机器的主目录(~),GUGU_HOME 底下(助理的家与工作目录都在那里);
 * 任务工作区(task-home)按固定 id 认。替人登记在这些目录上的项目是 workspace —— 不进任何项目列表、选择器、计数与账号
 * 项目表,会话列在「任务」里。只用在自动的入口上(createLocalProject 的 `automatic`:agent 建会话、App 派活、助理的目录、
 * 导入本机会话、远端不选目录);人在「添加项目」里亲手选的 ~ 是项目(owner 10-28)。
 */
export function isAppKeptDirectory(directory: string, dirs: AppKeptDirectories = currentDirectories()): boolean {
  const key = canonicalPath(directory);
  return key === canonicalPath(dirs.home) || inside(key, canonicalPath(dirs.guguHome))
    || (!!dirs.taskHome && inside(key, canonicalPath(dirs.taskHome)));
}
