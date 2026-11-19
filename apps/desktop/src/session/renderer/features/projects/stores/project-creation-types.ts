import type { Result } from '@gugu/session-shared';
import type { CreateProjectError } from '@shared/projects';

interface BaseModeData {
  name: string;
  path: string;
}

export interface PickModeData extends BaseModeData {
  mode: 'pick';
  initGitRepository?: boolean;
  createDirectory?: boolean;
  /** 非 git 目录也放行(本地「使用现有文件夹」);远程项目在主进程侧本就放行。 */
  allowNonGit?: boolean;
  /** #609 替人登记的目录(助理的家、远端主目录);人亲手选的不给。 */
  automatic?: boolean;
  githubAccountId?: string;
}

export type ModeData = PickModeData;

/** machine:#6264 在哪台机器上建(那台机器上的文件夹);缺席 = 本机。 */
export type ProjectType = { type: 'local'; machine?: string | null };

export type ProjectCreationError = CreateProjectError;

export type ProjectCreationCompletion = Result<void, ProjectCreationError>;

export type StartProjectCreationResult =
  | { kind: 'existing'; projectId: string }
  | { kind: 'creating'; projectId: string; completion: Promise<ProjectCreationCompletion> };

export interface StartProjectCreationOptions {
  id?: string;
}
