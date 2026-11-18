import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { PhoneMessagesEmpty } from './PhoneMessagesEmpty'
import { requestGroupAgentCreation } from '@/lib/uiEvents'
import { taskFoldersOfChat } from './phoneTaskFolders'

/** 已有真实文件夹和群、尚未派第一件任务的项目。 */
export function PhoneProjectEmpty({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const { label, isHome } = useMachineLabel()
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const project = useMemo(() => taskFoldersOfChat(accountList.find((one) => one.chatId === chatId), devices, { label, isHome }), [accountList, devices, chatId, label, isHome])
  if (!project) return <PhoneMessagesEmpty />
  return <div data-testid="phone-project-empty">
    <PhoneMessagesEmpty action={<Button variant="secondary" size="sm" onClick={() => requestGroupAgentCreation(chatId)}>{t('chatList.createAgent')}</Button>} />
  </div>
}
