import type { Device } from '@gugu/core/shared/types/chat'
import type { FolderCardMachine } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { GroupFolder, GroupWithFolders } from '@renderer/features/folders/group-folders-store'

/** The machine a folder is on and its id there (a task started from it on the phone is created on that machine). */
export type TaskFolderHome = { deviceId: string; folderId: string; machine: FolderCardMachine }

export type ChatTaskFolders = {
  chatId: string
  name: string
  folders: GroupFolder[]
  homeOf: (folder: Pick<GroupFolder, 'deviceId' | 'id'>) => TaskFolderHome | undefined
}

/** A machine on the card: its name through useMachineLabel (the one way the phone names a machine). */
export function folderCardMachine(device: Device, label: (device: Device) => string): FolderCardMachine & { id: string } {
  return { id: device.device_id, label: label(device), online: device.is_online, kind: device.capabilities.host_kind === 'desktop' ? 'computer' : 'server' }
}

/**
 * A group's folder card on the phone (floats up when a new task is started there): the group's folders on my machines,
 * from the account's record (groupFoldersStore). A machine offline: its papers listed, marked offline. A group with no
 * folder on my machines = null (the strip shows in groups with folders; a task elsewhere runs in a task home, Q5).
 */
export function taskFoldersOfChat(group: GroupWithFolders | undefined, devices: readonly Device[], label: (device: Device) => string): ChatTaskFolders | null {
  if (!group || group.folders.length === 0) return null
  const byId = new Map(devices.map((device) => [device.device_id, device]))
  const folders = group.folders.flatMap((folder): GroupFolder[] => {
    const device = folder.deviceId ? byId.get(folder.deviceId) : undefined
    return device ? [{ ...folder, offline: folder.offline && !device.is_online }] : []
  })
  if (folders.length === 0) return null
  return {
    chatId: group.chatId,
    name: group.name,
    folders,
    homeOf: (folder) => {
      const device = folder.deviceId ? byId.get(folder.deviceId) : undefined
      return device ? { deviceId: device.device_id, folderId: folder.id, machine: folderCardMachine(device, label) } : undefined
    },
  }
}
