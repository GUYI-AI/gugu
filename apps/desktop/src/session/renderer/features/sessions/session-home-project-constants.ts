import { isAssistantHostProject } from '@renderer/features/projects/assistant-project-presentation';

/**
 * #609 唯一的「是不是项目」判据:workspace(任务工作区、~、助理与 App 的目录,主机按目录记在 `kind` 上)不是项目 ——
 * 不进项目列表、选择器与计数,会话列在「任务」里。旧云助理宿主按账号确认的身份投影,不依赖宿主已执行迁移。
 */
export function isWorkspaceProject(project: { id: string; data?: { kind?: string } | null }): boolean {
  return project.data?.kind === 'workspace' || isAssistantHostProject(project);
}
