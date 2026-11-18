import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import type { RunMachineCandidate } from '@renderer/features/projects/components/main-panel/project-run-machine'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import { isAssistantHome } from '@/lib/assistantHome'
import { phoneAccountProjects } from '../phoneAccountProjects'

/**
 * 手机「+」新建页的「项目 · 机器」两行(DESIGN 点击路径 4a):项目是账号上的,机器只是这一次跑在哪。
 *
 * `chatId` = 项目群(项目的 id),「上次在这个项目里用的机器」按它记。
 * `homes` = 这个项目绑在哪几台机器上 → 那台上的本地项目 id(建会话时带给那台机器)。
 */
export type CreateProject = { chatId: string; name: string; homes: ReadonlyMap<string, string> }

/**
 * 账号下的项目 = accountProjectsStore(桌面项目选择器同一份,归档的不列);各台机器上的本地项目就是它的绑定。
 * 合并与助理宿主的判据只走 phoneAccountProjects(#1629 只绑在个人助理宿主上的项目是助理的家,不列;那台宿主也不算项目的机器)。
 */
export function accountProjects(projects: readonly AccountProject[], devices: readonly Device[], cloudDeviceId: string | null): CreateProject[] {
  return phoneAccountProjects(projects, devices, (device) => isAssistantHome(device, cloudDeviceId)).map(({ project, members }) => ({
    chatId: project.chatId,
    name: project.name,
    homes: new Map(members.map((member) => [member.device.device_id, member.localProjectId] as const)),
  }))
}

/**
 * 机器列表里的一行。`localProjectId` = 选了项目时那台上的本地项目;没有这个项目的文件夹 = null(手机上还不能就地绑文件夹,点不动)。
 * `available` = 点得动:有文件夹(选了项目时)且此刻接活(在线,或可叫醒的云电脑;与桌面 machineAcceptsWork 同一条)。
 * `path` = 那台上这个项目的文件夹(行上写出来)。
 */
export type CreateMachine = { device: Device; localProjectId: string | null; path: string | null; available: boolean }

/**
 * 选了项目:有这个项目文件夹的机器在上(在线的在前),其余电脑在下、点不动。手机自己不是项目的运行机器(它没有文件夹)。
 * 不选项目:全部机器,电脑在前;手机任务宿主排在最后(它只跑自己的任务工作区)。
 */
export function createMachines(project: CreateProject | null, machines: readonly Device[]): CreateMachine[] {
  const computers = machines.filter((device) => !isPhoneDevice(device))
  if (!project) {
    return [...computers, ...machines.filter(isPhoneDevice)].map((device) => ({ device, localProjectId: null, path: null, available: deviceAcceptsWork(device) }))
  }
  const rows = computers.map((device) => {
    const localProjectId = project.homes.get(device.device_id) ?? null
    const path = device.projects?.find((record) => record.localProjectId === localProjectId)?.folders[0]?.path ?? null
    return { device, localProjectId, path }
  })
  const rank = (row: (typeof rows)[number]) => (row.localProjectId === null ? 2 : row.device.is_online ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b)).map((row) => ({ ...row, available: row.localProjectId !== null && deviceAcceptsWork(row.device) }))
}

/**
 * 默认在哪台跑的候选:与桌面同一条规则(useProjectRunMachine → defaultRunMachine),候选 = 能选的那几台,次序同列表。
 * 手机上没有「本机」那一步(手机不是项目的运行机器)。候选 = 有文件夹的(选了项目时)/ 全部(不选项目),离线的也在候选里 ——
 * 与桌面同一条:离线的在列表里点不动,但选着的那台掉线了照样选着、发送挡住、草稿留着(❌ 整个新建框消失)。
 */
export function runCandidates(rows: readonly CreateMachine[], project: CreateProject | null): RunMachineCandidate[] {
  return rows.filter((row) => !project || row.localProjectId !== null).map((row) => ({ key: row.device.device_id, online: deviceAcceptsWork(row.device) }))
}
