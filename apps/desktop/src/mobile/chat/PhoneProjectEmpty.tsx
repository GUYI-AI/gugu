import { useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useDevicesStore } from '@/store/devicesContext'
import { groupFoldersStore } from '@/session/renderer/features/folders/group-folders-store'
import { useMachineLabel } from '@/components/session-watch/useMachineLabel'
import { PhoneMessagesEmpty } from './PhoneMessagesEmpty'
import { requestGroupAgentCreation } from '@/lib/uiEvents'
import { taskFoldersOfChat } from './phoneTaskFolders'

/** 挂了文件夹、尚未派第一件任务的群。 */
export function PhoneProjectEmpty({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { devices } = useDevicesStore()
  const { label } = useMachineLabel()
  const groups = useSyncExternalStore(groupFoldersStore.subscribe, () => groupFoldersStore.groups)
  const project = useMemo(() => taskFoldersOfChat(groups.find((one) => one.chatId === chatId), devices, label), [groups, devices, chatId, label])
  if (!project) return <PhoneMessagesEmpty />
  return <div data-testid="phone-project-empty">
    <PhoneMessagesEmpty action={<Button variant="secondary" size="sm" onClick={() => requestGroupAgentCreation(chatId)}>{t('chatList.createAgent')}</Button>} />
  </div>
}
