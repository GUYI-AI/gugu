import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

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
