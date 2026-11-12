import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { AssistantHomeRow } from '@/lib/assistantHome'
import type { FolderCardMachine } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders'
import { phoneAccountProjects } from '../phoneAccountProjects'

/** 一张文件夹从哪台机器、哪个本地项目开工(手机派新任务时带给那台机器)。 */
export type TaskFolderHome = { deviceId: string; localProjectId: string; machine: FolderCardMachine }

export type ChatTaskFolders = {
  /** 代表这个项目的那一个本地项目(卡片的 projectId,封面颜色按它定)。 */
  rowId: string
  name: string
  /** 这个项目在各台机器上的本地项目(都绑着这个群)。 */
  memberIds: string[]
  folders: ShownFolder[]
  homeOf: (localProjectId: string) => TaskFolderHome | undefined
}

/** 卡上一台机器的样子:名字走 useMachineLabel(手机上说到一台机器只有这一个叫法)。 */
export function folderCardMachine(device: Device, label: (device: Device) => string): FolderCardMachine & { id: string } {
  return { id: device.device_id, label: label(device), online: device.is_online, kind: device.capabilities.host_kind === 'desktop' ? 'computer' : 'server' }
}

/**
 * 一个项目群的文件夹卡(手机派新任务时浮出来的那张):项目 = accountProjectsStore 里这个群(`project`),各台机器上的那一份
 * 走 phoneAccountProjects(个人助理宿主不算,代表按 groupRowOrder);文件夹照那台发布在账号上的 device_projects。
 * 那台离线,纸照列、标离线;那台的项目这一端没读到(projects_error),纸标「上次的」。
 * 不是账号上的项目 / 一台机器都没有 = null。
 */
export function taskFoldersOfChat(
  project: AccountProject | undefined,
  devices: readonly Device[],
  machines: { label: (device: Device) => string; isHome: (device: AssistantHomeRow) => boolean },
): ChatTaskFolders | null {
  const [entry] = project ? phoneAccountProjects([project], devices, machines.isHome) : []
  const [row] = entry?.members ?? []
  if (!entry || !row) return null
  const homes = new Map<string, TaskFolderHome>()
  const folders: ShownFolder[] = []
  for (const { device, localProjectId, record } of entry.members) {
    homes.set(localProjectId, { deviceId: device.device_id, localProjectId, machine: folderCardMachine(device, machines.label) })
    for (const folder of record?.folders ?? []) {
      folders.push({
        workspaceId: folder.workspaceId,
        projectId: localProjectId,
        kind: folder.kind,
        path: folder.path,
        branch: null,
        sessionIds: [],
        attachedAt: folder.attachedAt,
        offline: !device.is_online,
        deviceId: device.device_id,
        ...(device.projects_error ? { stale: true } : {}),
      })
    }
  }
  return { rowId: row.localProjectId, name: entry.project.name, memberIds: [...homes.keys()], folders, homeOf: (id) => homes.get(id) }
}
