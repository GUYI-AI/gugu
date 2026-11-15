import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import type { AssistantHomeRow } from '@/lib/assistantHome'
import { groupRowOrder } from '@/session/renderer/features/projects/stores/project-group-layout'

/** 一个项目在一台机器上的那一份:那台机器、它上面的本地项目、那台发布在账号上的记录(还没读到 = undefined)。 */
export type PhoneProjectMember = { device: Device; localProjectId: string; record: DeviceProject | undefined }

/** 账号上的一个项目在手机上:`members` 按 groupRowOrder 排(第一个 = 代表,与桌面侧栏那一行同一个);一台都没有 = []。 */
export type PhoneAccountProject = { project: AccountProject; members: PhoneProjectMember[] }

const orderRow = (member: PhoneProjectMember) => ({
  id: member.localProjectId,
  machine: member.device.is_current_device ? null : member.device.device_id,
  online: member.device.is_online,
  createdAt: member.record?.createdAt ?? null,
})

/**
 * 手机上「一个项目跨几台机器合成一个」只有这一条(伙伴、派任务的文件夹卡、助理 → 工作区、新建页):
 * 项目 = accountProjectsStore 的列表(桌面同一份,归档的不列),各台机器上的那一份 = 它的绑定。
 * 手机没有本地项目表(accountProjectsStore.membersOf / representativeOf 答的是桌面那张表),代表按同一条 groupRowOrder 排。
 * #1629 个人助理宿主(`isHome`,useMachineLabel 同一个判据)不算项目的机器;只绑在它上面的项目是助理的家,不列。
 */
export function phoneAccountProjects(
  projects: readonly AccountProject[],
  devices: readonly Device[],
  isHome: (device: AssistantHomeRow) => boolean,
): PhoneAccountProject[] {
  const byDevice = new Map(devices.map((device) => [device.device_id, device]))
  const home = (deviceId: string) => isHome(byDevice.get(deviceId) ?? { device_id: deviceId })
  return projects.flatMap((project) => {
    if (project.archived) return []
    if (project.bindings.length > 0 && project.bindings.every((binding) => home(binding.deviceId))) return []
    const members = project.bindings.flatMap(({ deviceId, localProjectId }): PhoneProjectMember[] => {
      const device = byDevice.get(deviceId)
      if (!device || home(deviceId)) return []
      return [{ device, localProjectId, record: device.projects?.find((record) => record.localProjectId === localProjectId) }]
    })
    return [{ project, members: members.sort((a, b) => groupRowOrder(orderRow(a), orderRow(b))) }]
  })
}

/** 这个项目的文件夹里有读不到、列着上次那份的机器(设备 store 的 projects_error)。 */
export function hasStaleMember(members: readonly PhoneProjectMember[]): boolean {
  return members.some((member) => !!member.device.projects_error)
}
