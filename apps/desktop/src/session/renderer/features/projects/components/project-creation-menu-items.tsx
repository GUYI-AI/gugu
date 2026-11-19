import { FolderOpen, Plus } from '@/lib/icons'
import { createGroupFromFolder } from '@renderer/features/folders/create-group-from-folder'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { rpc } from '@renderer/lib/ipc'
import { useShowModal } from '@renderer/lib/modal/modal-provider'
import { DropdownMenuItem } from '@renderer/lib/ui/dropdown-menu'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { log } from '@renderer/utils/logger'
import { isWebTarget } from '@/lib/target'

/** #6264 文件夹在别的机器上:新文件夹建在那台机器的默认位置下,「用现有文件夹」浏览那台机器(照 VS Code Remote「Open Folder」)。 */
export type ProjectCreationMachine = {
  deviceId: string
  label: string
  /** 浏览那台机器的文件夹从哪开始。 */
  browseFrom: string
}

export function ProjectCreationMenuItems({
  onProjectReady,
  machine = null,
  disabled = false
}: {
  /** The new group (chat id), its folder bound. */
  onProjectReady?: (chatId: string) => void
  /** null = 本机。 */
  machine?: ProjectCreationMachine | null
  disabled?: boolean
}) {
  const { translate } = useSessionMessages()
  const showCreateProjectNameModal = useShowModal('createProjectNameModal')
  const showLocalFolderProjectModal = useShowModal('localFolderProjectModal')

  const handleExistingFolder = async () => {
    if (machine) {
      // 那台机器上的目录选择器由宿主画(与侧栏、新建框「浏览那台机器」同一个),选中后建群、把它挂进去。
      const path = await remoteHostsStore.pickFolder(machine.deviceId, machine.browseFrom)
      if (!path) return
      const chatId = await createGroupFromFolder(path, translate, machine.deviceId)
      if (chatId) onProjectReady?.(chatId)
      return
    }
    // @@@task-web-host — 网页版没有系统文件夹对话框(无头宿主里只会静默取消,owner 实测「点了没反应」)
    // → 开咕咕自己的小弹窗:应用内目录浏览器 + 零命名。❌ 不接旧的 AddProjectModal。
    if (isWebTarget) {
      showLocalFolderProjectModal({ onSuccess: (chatId) => onProjectReady?.(chatId) })
      return
    }
    const path = await rpc.app.openSelectDirectoryDialog({
      title: translate('projects.create.pickFolderTitle'),
      message: translate('projects.create.pickFolderMessage')
    })
    if (!path) return
    const chatId = await createGroupFromFolder(path, translate)
    if (chatId) onProjectReady?.(chatId)
  }

  return (
    <>
      <DropdownMenuItem
        disabled={disabled}
        data-testid="project-create-blank"
        onClick={() =>
          showCreateProjectNameModal({
            machine: machine ? { deviceId: machine.deviceId, label: machine.label } : null,
            onSuccess: (chatId) => onProjectReady?.(chatId)
          })
        }
      >
        <Plus className="size-3.5" />
        <span>{translate('projects.create.blankProject')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled}
        data-testid="project-create-existing"
        onClick={() =>
          void handleExistingFolder().catch((error: unknown) =>
            log.error('[folders] 用现有文件夹建群失败', { machine: machine?.deviceId ?? null, error })
          )
        }
      >
        <FolderOpen className="size-3.5" />
        <span>{translate('projects.create.existingFolder')}</span>
      </DropdownMenuItem>
    </>
  )
}
