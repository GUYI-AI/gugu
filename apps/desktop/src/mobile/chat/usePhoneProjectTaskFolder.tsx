import { useMemo, useState, useSyncExternalStore, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicesStore } from '@/store/devicesContext'
import { groupFoldersStore, type GroupFolder } from '@/session/renderer/features/folders/group-folders-store'
import type { GroupFoldersState } from '@/session/renderer/features/folders/group-folders'
import { ProjectFolderCard } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { CreateMachine } from '@/components/session-watch/create-target'
import { useMachineLabel } from '@/components/session-watch/useMachineLabel'
import { PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { projectRpcOn } from '../partners/projectRpc'
import { taskFoldersOfChat } from './phoneTaskFolders'
import { usePhoneFolderAttach } from './usePhoneFolderAttach'

/** A group's chosen folder decides where the creation form creates the task (the machine and its folder there). */
export function usePhoneProjectTaskFolder(chatId: string | undefined) {
  const { t } = useTranslation('mobileCreateControls')
  const { devices, refresh } = useDevicesStore()
  const { label: machineLabel } = useMachineLabel()
  const groups = useSyncExternalStore(groupFoldersStore.subscribe, () => groupFoldersStore.groups)
  const group = chatId ? groups.find((one) => one.chatId === chatId) : undefined
  const listed = useMemo(() => taskFoldersOfChat(group, devices, machineLabel), [group, devices, machineLabel])
  const attach = usePhoneFolderAttach(listed, devices, refresh)
  const project = useMemo(() => listed ? {
    ...listed,
    folders: [...new Map([...listed.folders, ...attach.added.map((item) => item.folder)].map((folder) => [folder.id, folder])).values()],
    homeOf: (folder: Pick<GroupFolder, 'deviceId' | 'id'>) => attach.added.find((item) => item.folder.id === folder.id)?.home ?? listed.homeOf(folder),
  } : null, [listed, attach.added])
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<RefObject<HTMLButtonElement | null> | null>(null)
  const chosen = project?.folders.find(folder => folder.id === chosenId) ?? null
  const home = chosen ? project?.homeOf(chosen) : undefined
  const device = devices.find(row => row.device_id === home?.deviceId)
  const machine: CreateMachine | undefined = device && home && chosen
    ? { device, folderId: home.folderId, path: chosen.path, available: home.machine.online }
    : undefined

  const folderState: GroupFoldersState | null = project ? {
    folders: project.folders,
    loadError: false,
    stale: groupFoldersStore.status === 'error',
    chosen,
    fresh: attach.fresh,
    choose: (folderId) => {
      const folder = project.folders.find((candidate) => candidate.id === folderId)
      if (folder) { setChosenId(folder.id); setAnchor(null) }
    },
    reload: () => { void groupFoldersStore.refresh() },
    bound: () => undefined,
    detach: async (folder) => {
      const device = devices.find((row) => row.device_id === folder.deviceId)
      if (!device) throw new Error('folder machine not found')
      const result = await projectRpcOn(device).folders.unbindFolder(folder.id)
      if (!result.success) throw new Error(result.error.type)
      attach.remove(folder.id)
      await refresh()
      void groupFoldersStore.refresh()
    },
  } : null

  const folderPickerOpen = !!anchor && !!project && !!folderState
  const overlay = <>{attach.picker}{folderPickerOpen && project && folderState ? (
    <PhoneComposerSheet open anchor={anchor ?? undefined} title={t('project')} testId="phone-task-folder-card"
      onClose={() => setAnchor(null)}>
      <ProjectFolderCard
        chatId={project.chatId}
        groupName={project.name}
        folders={folderState}
        machines={[...new Set(project.folders.map((folder) => folder.deviceId))]}
        machineOf={(deviceId) => project.folders.map((folder) => project.homeOf(folder)).find((home) => home?.deviceId === deviceId)?.machine ?? { label: '', online: false, kind: 'computer' }}
        attachMachines={attach.attachMachines}
        onAttach={attach.onAttach}
        onDropFolder={() => undefined}
        floating
        touch
      />
    </PhoneComposerSheet>
  ) : null}</>

  return project ? {
    machine,
    control: { open: folderPickerOpen, onFolder: setAnchor },
    overlay,
  } : null
}
