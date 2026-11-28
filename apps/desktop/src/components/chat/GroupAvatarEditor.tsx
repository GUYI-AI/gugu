import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings } from '@gugu/core/shared/types/chat'
import { useGroupAvatarUpload } from './useGroupAvatarUpload'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

/** The group card and details expose the same face, permissions, image drop and editor. */
export function GroupAvatarControl({ chatId, name, settings, fallbackUrl, size, setAvatarUrl, onError, square, still, testId = 'group-avatar' }: {
  chatId: string
  name: string
  settings: GroupChatSettings | null
  fallbackUrl?: string | null
  size: number
  setAvatarUrl: (url: string | null) => void
  onError: (error: string | null) => void
  square?: boolean
  still?: boolean
  testId?: string
}) {
  const { t } = useTranslation('messaging')
  const [editing, setEditing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const canEdit = settings?.can_manage === true
  const url = settings ? settings.avatar_url : fallbackUrl
  const { avatarUploading, handleAvatarFile, handleAvatarReset } = useGroupAvatarUpload({
    chatId, viewerIsManager: canEdit, setAvatarUrl, setActionError: onError,
  })
  const face = <Avatar variant="group" seed={chatId} name={name} avatarUrl={url} size={size} still={still} />
  if (!canEdit) return <span data-testid={testId}>{face}</span>
  return <>
    <button type="button" data-testid={testId} aria-label={t('group.settings.changeAvatar')} title={t('group.settings.changeAvatar')}
      disabled={avatarUploading} onClick={() => setEditing(true)}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void handleAvatarFile(event.dataTransfer.files[0]) }}
      style={{ width: size, height: size }}
      className={`relative grid shrink-0 cursor-pointer place-items-center overflow-hidden border-0 bg-transparent p-0 disabled:cursor-default ${square ? 'rounded-[var(--radius-2xl)]' : 'rounded-full'} ${dragging ? 'outline-1 outline-dashed outline-[var(--primary)]' : ''}`}>
      {face}
      {avatarUploading && <span className="absolute inset-0 grid place-items-center bg-[var(--bg-overlay-modal)] text-[length:var(--font-caption)] text-[var(--color-white)]">{t('group.settings.uploading')}</span>}
    </button>
    {editing && <GroupAvatarEditor chatId={chatId} groupName={name} avatarUrl={url ?? null} busy={avatarUploading}
      onFile={handleAvatarFile} onReset={handleAvatarReset} onClose={() => setEditing(false)} />}
  </>
}

/** 「修改头像」: a picture of one's own, or back to the default face. The default face itself is not editable. */
export function GroupAvatarEditor({ chatId, groupName, avatarUrl, busy, onFile, onReset, onClose }: {
  chatId: string
  groupName: string
  avatarUrl: string | null
  busy: boolean
  onFile: (file: File) => Promise<void>
  onReset: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <Sheet onClose={() => { if (!busy) onClose() }} desktopWidth="min(360px, 100%)" mobileFitContent testId="group-avatar-editor" ariaLabel={t('group.settings.avatarEditor.title')}>
      <div className="flex flex-col items-center gap-4 !p-5">
        <h3 className="m-0 self-start text-[length:var(--font-heading)] font-semibold text-[var(--text-primary)]">{t('group.settings.avatarEditor.title')}</h3>
        <Avatar variant="group" name={groupName} avatarUrl={avatarUrl} seed={chatId} size={96} />
        <input ref={fileInput} type="file" accept="image/*" hidden
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void onFile(file).then(onClose) }} />
        <div className="flex w-full flex-col gap-2">
          <Button variant="primary" data-testid="group-avatar-upload" disabled={busy} onClick={() => fileInput.current?.click()}>{t('group.settings.avatarEditor.upload')}</Button>
          <Button variant="ghost" data-testid="group-avatar-reset" disabled={busy || !avatarUrl} onClick={() => { void onReset().then(onClose) }}>{t('group.settings.avatarEditor.reset')}</Button>
        </div>
      </div>
    </Sheet>
  )
}
