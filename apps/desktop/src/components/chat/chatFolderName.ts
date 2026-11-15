import { useTranslation } from 'react-i18next'

/** What people call a chat's folder (the preinstalled workspace App; code keeps saying workspace): 文件 / Files, in every chat. */
export function useChatFolderName(): string {
  const { t } = useTranslation('messaging')
  return t('header.folder')
}
