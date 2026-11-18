import { useMemo, useState, useSyncExternalStore, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevicesStore } from '@/store/devicesContext'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { ProjectFolderCard } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { ProjectFoldersState } from '@renderer/features/projects/components/main-panel/project-folders'
import type { CreateMachine } from '../agent-watch/create-target'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { projectRpcOn } from '../partners/projectRpc'
import { taskFoldersOfChat } from './phoneTaskFolders'
import { usePhoneFolderAttach } from './usePhoneFolderAttach'

/** The project group's selected folder determines the existing creation form's execution target. */
export function usePhoneProjectTaskFolder(chatId: string | undefined) {
  const { t } = useTranslation('mobileCreateControls')
  const { devices, refresh } = useDevicesStore()
  const { label: machineLabel, isHome } = useMachineLabel()
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const accountProject = useMemo(
    () => (chatId ? taskFoldersOfChat(accountList.find((one) => one.chatId === chatId), devices, { label: machineLabel, isHome }) : null),
    [chatId, accountList, devices, machineLabel, isHome],
  )
  const attach = usePhoneFolderAttach(accountProject, devices, refresh)
  const project = useMemo(() => accountProject ? {
    ...accountProject,
    memberIds: [...new Set([...accountProject.memberIds, ...attach.added.map((item) => item.folder.projectId)])],
    folders: [...new Map([...accountProject.folders, ...attach.added.map((item) => item.folder)].map((folder) => [folder.workspaceId, folder])).values()],
    homeOf: (id: string) => attach.added.find((item) => item.folder.projectId === id)?.home ?? accountProject.homeOf(id),
  } : null, [accountProject, attach.added])
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<RefObject<HTMLButtonElement | null> | null>(null)
  const chosen = project?.folders.find(folder => folder.workspaceId === chosenId) ?? null
  const home = chosen ? project?.homeOf(chosen.projectId) : undefined
  const device = devices.find(row => row.device_id === home?.deviceId)
  const machine: CreateMachine | undefined = device && home && chosen
    ? { device, localProjectId: home.localProjectId, path: chosen.path, available: home.machine.online }
    : undefined

  const folderState: ProjectFoldersState | null = project ? {
    folders: project.folders,
    loadError: false,
    unanswered: [],
    chosen,
    fresh: attach.fresh,
    choose: (workspaceId) => {
      const folder = project.folders.find((candidate) => candidate.workspaceId === workspaceId)
      if (folder) { setChosenId(folder.workspaceId); setAnchor(null) }
    },
    reload: () => undefined,
    // 挂文件夹由同一张卡的机器菜单进入 RemoteFolderPicker。
    attach: async (id, path) => {
      const device = devices.find((row) => row.device_id === project.homeOf(id)?.deviceId)
      if (!device) return { ok: false, error: { type: 'rpc-failed', message: 'project machine not found' } }
      const result = await projectRpcOn(device).projects.attachProjectFolder(id, path)
      if (!result.success) return { ok: false, error: result.error }
      await refresh()
      return { ok: true, folder: result.data }
    },
    detach: async (folder) => {
      const device = devices.find((row) => row.device_id === project.homeOf(folder.projectId)?.deviceId)
      if (!device) throw new Error('project machine not found')
      const result = await projectRpcOn(device).projects.detachProjectFolder(folder.projectId, folder.workspaceId)
      if (!result.success) throw new Error(result.error.message)
      attach.remove(folder.workspaceId)
      await refresh()
      return true
    },
  } : null

  const folderPickerOpen = !!anchor && !!project && !!folderState
  const overlay = <>{attach.picker}{folderPickerOpen && project && folderState ? (
    <PhoneComposerSheet open anchor={anchor ?? undefined} title={t('project')} testId="phone-task-folder-card"
      onClose={() => setAnchor(null)}>
      <ProjectFolderCard
        projectId={project.rowId}
        projectName={project.name}
        folders={folderState}
        memberIds={project.memberIds}
        machines={[...new Set(project.memberIds.map((id) => project.homeOf(id)?.deviceId ?? null))]}
        machineOf={(deviceId) => project.memberIds.map((id) => project.homeOf(id)).find((home) => home?.deviceId === deviceId)?.machine ?? { label: '', online: false, kind: 'computer' }}
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
