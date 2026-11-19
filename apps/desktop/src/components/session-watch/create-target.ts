import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import type { RunMachineCandidate } from '@renderer/features/projects/components/main-panel/project-run-machine'
import type { GroupWithFolders } from '@renderer/features/folders/group-folders-store'

/**
 * 手机「+」新建页的「群 · 机器」两行(DESIGN 点击路径 4a):群里的文件夹在哪些机器上,机器只是这一次跑在哪。
 *
 * `chatId` = 群,「上次在这个群里用的机器」按它记。
 * `homes` = 这个群在哪几台机器上有文件夹 → 那台上默认开工的那个文件夹(id 与路径;建会话时带给那台机器)。
 */
export type CreateProject = { chatId: string; name: string; homes: ReadonlyMap<string, { folderId: string; path: string }> }

/**
 * 挂了文件夹的群(groupFoldersStore,桌面群选择器同一份)。#1629:个人助理宿主上的文件夹是助理的家,不列,那台宿主也不算群的
 * 机器;文件夹全在那台上的群整个不列(与从前只绑在助理宿主上的项目同一条)。
 */
export function accountProjects(groups: readonly GroupWithFolders[], devices: readonly Device[], isAssistantHome: (device: Device) => boolean): CreateProject[] {
  const home = new Set(devices.filter(isAssistantHome).map((device) => device.device_id))
  return groups.flatMap((group) => {
    const folders = group.folders.filter((folder) => !folder.deviceId || !home.has(folder.deviceId))
    if (group.folders.length > 0 && folders.length === 0) return []
    const homes = new Map<string, { folderId: string; path: string }>()
    for (const folder of folders) {
      if (folder.deviceId && !homes.has(folder.deviceId)) homes.set(folder.deviceId, { folderId: folder.id, path: folder.path })
    }
    return [{ chatId: group.chatId, name: group.name, homes }]
  })
}

/**
 * 机器列表里的一行。`folderId` = 选了群时那台上开工的文件夹;没有这个群的文件夹 = null(点不动)。
 * `available` = 点得动:有文件夹(选了群时)且此刻接活(在线,或可叫醒的云电脑;与桌面 machineAcceptsWork 同一条)。
 * `path` = 那台上这个群的文件夹(行上写出来)。
 */
export type CreateMachine = { device: Device; folderId: string | null; path: string | null; available: boolean }

/**
 * 选了群:有这个群文件夹的机器在上(在线的在前),其余电脑在下、点不动。手机自己不是运行机器(它没有文件夹)。
 * 不选群:全部机器,电脑在前;手机任务宿主排在最后(它只跑自己的任务工作区)。
 */
export function createMachines(project: CreateProject | null, machines: readonly Device[]): CreateMachine[] {
  const computers = machines.filter((device) => !isPhoneDevice(device))
  if (!project) {
    return [...computers, ...machines.filter(isPhoneDevice)].map((device) => ({ device, folderId: null, path: null, available: deviceAcceptsWork(device) }))
  }
  const rows = computers.map((device) => {
    const home = project.homes.get(device.device_id)
    return { device, folderId: home?.folderId ?? null, path: home?.path ?? null }
  })
  const rank = (row: (typeof rows)[number]) => (row.folderId === null ? 2 : row.device.is_online ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b)).map((row) => ({ ...row, available: row.folderId !== null && deviceAcceptsWork(row.device) }))
}

/**
 * 默认在哪台跑的候选:与桌面同一条规则(useProjectRunMachine → defaultRunMachine),候选 = 能选的那几台,次序同列表。
 * 手机上没有「本机」那一步(手机不是项目的运行机器)。候选 = 有文件夹的(选了项目时)/ 全部(不选项目),离线的也在候选里 ——
 * 与桌面同一条:离线的在列表里点不动,但选着的那台掉线了照样选着、发送挡住、草稿留着(❌ 整个新建框消失)。
 */
export function runCandidates(rows: readonly CreateMachine[], project: CreateProject | null): RunMachineCandidate[] {
  return rows.filter((row) => !project || row.folderId !== null).map((row) => ({ key: row.device.device_id, online: deviceAcceptsWork(row.device) }))
}
