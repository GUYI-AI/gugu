// 一台机器的主目录项目:那台上路径 = 主目录的项目(新建时复用它,❌ 另建一个同路径的)。
import { sameFolder } from '@shared/core/projects/folder-path';
export { sameFolder } from '@shared/core/projects/folder-path';

export type MachineHomeProject = { id: string; path?: string | null };

/** 那台机器上路径 = 主目录的项目(复用,❌ 另建一个同路径的)。 */
export function findHomeProject<P extends MachineHomeProject>(projects: readonly P[], homeDir: string | null): P | null {
  if (!homeDir) return null;
  return projects.find((project) => sameFolder(project.path, homeDir)) ?? null;
}
