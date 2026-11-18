import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { DeviceProjectFolder } from '@gugu/core/shared/types/deviceProject'
import type { AssistantHomeRow } from '@/lib/assistantHome'
import { hasStaleMember, phoneAccountProjects } from '../phoneAccountProjects'

/** `stale` = 那台(文件夹上)/ 有一台(项目上)的文件夹这一端没读到,列着的是上次那份。 */
export type PhoneProjectEntry = { id: string; label: string; rootPath: string | null; folders: (DeviceProjectFolder & { stale: boolean })[]; stale: boolean }

/**
 * 手机「助理 → 工作区」的项目列表:项目与合并只走 phoneAccountProjects(accountProjectsStore 那一份);文件夹路径照
 * 设备 store 里各台机器发布的 device_projects(❌ 这一页自己再读一份)。
 */
export function phoneProjectRows(projects: readonly AccountProject[], devices: readonly Device[], isHome: (device: AssistantHomeRow) => boolean): PhoneProjectEntry[] {
  return phoneAccountProjects(projects, devices, isHome).map(({ project, members }) => {
    const folders = members.flatMap((member) => (member.record?.folders ?? []).map((folder) => ({ ...folder, stale: !!member.device.projects_error })))
    return { id: project.chatId, label: project.name, rootPath: folders[0]?.path ?? null, folders, stale: hasStaleMember(members) }
  })
}
