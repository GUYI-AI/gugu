import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'
import { useToast } from '../toastContext'

const avatarLog = rendererLogger('chat/group-avatar')

/** The group's avatar upload and its reset to the default face keep the same write and failure feedback. */
export function useGroupAvatarUpload({ chatId, viewerIsManager, setAvatarUrl, setActionError }: {
  chatId: string
  viewerIsManager: boolean
  setAvatarUrl: (url: string | null) => void
  setActionError: (error: string | null) => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [avatarUploading, setAvatarUploading] = useState(false)
  // @@@group-avatar (#1164 G1) manager 选/拖图 → 校验(image/* + ≤5MB) → 上传 → 即时换头像。
  const handleAvatarFile = useCallback(async (file: File | null | undefined) => {
    if (!viewerIsManager || avatarUploading || !file) return
    if (!file.type.startsWith('image/')) { setActionError(t('group.settings.imageRequired')); return }
    if (file.size > 5 * 1024 * 1024) { setActionError(t('group.settings.imageTooLarge')); return }
    setAvatarUploading(true)
    setActionError(null)
    try {
      setAvatarUrl(await chatService.uploadGroupAvatar(chatId, file))
      toast(t('group.settings.avatarUpdated'), 'success')
    } catch (err) {
      setActionError(t('group.settings.avatarUploadFailed', { reason: String((err as Error)?.message ?? err) }))
    } finally {
      setAvatarUploading(false)
    }
  }, [avatarUploading, chatId, setActionError, setAvatarUrl, t, toast, viewerIsManager])
  const handleAvatarReset = useCallback(async () => {
    if (!viewerIsManager || avatarUploading) return
    setAvatarUploading(true)
    setActionError(null)
    try {
      await chatService.resetGroupAvatar(chatId)
      setAvatarUrl(null)
      toast(t('group.settings.avatarUpdated'), 'success')
    } catch (err) {
      avatarLog.error({ chatId, err }, 'restore default group avatar failed')
      setActionError(t('group.settings.avatarResetFailed'))
    } finally {
      setAvatarUploading(false)
    }
  }, [avatarUploading, chatId, setActionError, setAvatarUrl, t, toast, viewerIsManager])
  return { avatarUploading, handleAvatarFile, handleAvatarReset }
}
