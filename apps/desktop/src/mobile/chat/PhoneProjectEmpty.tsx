import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { ProjectFolderAvatar } from '../partners/ProjectFolderAvatar'
import { startPhoneNewTask } from './PhoneNewTask'
import { taskFoldersOfChat } from './phoneTaskFolders'

/** 已有真实文件夹和群、尚未派第一件任务的项目。 */
export function PhoneProjectEmpty({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const { label, isHome } = useMachineLabel()
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const project = useMemo(() => taskFoldersOfChat(accountList.find((one) => one.chatId === chatId), devices, { label, isHome }), [accountList, devices, chatId, label, isHome])
  if (!project) return t('chatArea.noMessages')
  return <div className="gg-phone-project-empty" data-testid="phone-project-empty">
    <ProjectFolderAvatar coverId={project.rowId} size={64} />
    <span>{project.name}</span>
    <Button variant="secondary" size="sm" className="gg-phone-project-empty-start" onClick={() => startPhoneNewTask(chatId)}>{t('composer.phoneTask.action')}</Button>
  </div>
}
