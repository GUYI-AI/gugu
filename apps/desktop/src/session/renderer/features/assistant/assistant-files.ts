// #7199 个人助理的家(云上那台,或人自己的一台电脑;位置见 assistantHomePaths),这一页读写的几样东西在那台机器上都是文件(下面按云上那一份说):
//   说明 / 性格 = ~/.claude/CLAUDE.md 里管家那段之外的部分(管家那段每次开通 / 升级都会被它整段覆盖);
//   记忆 = Claude Code 给这个工作目录记的那一夹(~/.claude/projects/<目录名>/memory/,MEMORY.md 是索引);
//   技能 = ~/.claude/skills/<名字>/SKILL.md(自己做的那些);
//   给它的资料 = 主目录下一个文件夹,人放进去,再叫助理去看。
// 这里只放纯解析与拼装(可单测),读写在 assistant-machine.ts。
import {
  ASSISTANT_RESOURCES_DIR_NAME,
  assistantHomePaths,
  type AssistantHomeKind,
  type AssistantHomePaths,
} from '@gugu/core/shared/assistantPolicy';

export { MANAGED_BLOCK_MARKERS, splitInstructions, composeInstructions } from '@gugu/core/shared/assistantInstructions';
export type { InstructionsParts } from '@gugu/core/shared/assistantInstructions';

export { claudeProjectDirName } from '@gugu/core/shared/assistantPolicy';

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export type AssistantPaths = AssistantHomePaths;

/** 人放给助理看的资料放在这一夹(「添加与你有关的文件」)。 */
export const RESOURCES_DIR_NAME = ASSISTANT_RESOURCES_DIR_NAME;

/** 它家里那几样在哪(住云上 / 住电脑位置不同,见 @gugu/core/shared/assistantPolicy 的 assistantHomePaths)。 */
export function assistantPaths(home: string, projectPath: string, kind: AssistantHomeKind = 'cloud'): AssistantPaths {
  return assistantHomePaths(home, projectPath, kind);
}

import { readFrontmatter } from '@gugu/core/shared/assistantMemory';
export { readFrontmatter,parseMemoryNote,memoryIndexHints,removeIndexEntry,isOwnerProfileNote } from '@gugu/core/shared/assistantMemory';
export type { MemoryNote,MemoryKind } from '@gugu/core/shared/assistantMemory';

export type SkillInfo = {
  /** 技能所在的那一夹名字(删除、编辑都按它)。 */
  dir: string;
  name: string;
  description: string;
  body: string;
};

export function parseSkill(dir: string, text: string): SkillInfo {
  const { fields, body } = readFrontmatter(text);
  return { dir, name: fields.name || dir, description: fields.description ?? '', body };
}

// 上传规矩与名字规矩搬到了 @gugu/core/shared/assistantResourceRules(主进程替 App 上传时照同一套,#48)。
export { RESOURCE_MAX_BYTES, resourceRejection, folderNameProblem } from '@gugu/core/shared/assistantResourceRules';
export type { ResourceRejection } from '@gugu/core/shared/assistantResourceRules';

