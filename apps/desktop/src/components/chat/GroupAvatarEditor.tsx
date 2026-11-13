import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Check } from '@/lib/icons'
import { GROUP_AVATAR_COLORS, GROUP_AVATAR_PICTURE_FILL, groupAvatarColor, groupAvatarDefaultText, groupAvatarSvg } from '@gugu/core/shared/ui/groupAvatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

const PNG_SIZE = 416

/** The composed face as a picture: a group's avatar is always one uploaded image, whoever drew it. */
async function groupAvatarPng(face: { color: string; text: string }): Promise<File> {
  const url = URL.createObjectURL(new Blob([groupAvatarSvg({ ...face, fill: GROUP_AVATAR_PICTURE_FILL, px: PNG_SIZE, fixed: true })], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = PNG_SIZE
    canvas.getContext('2d')!.drawImage(image, 0, 0, PNG_SIZE, PNG_SIZE)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Group avatar could not be drawn')
    return new File([blob], 'group-avatar.png', { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 「修改头像」: a few characters and one of eight colours, or a picture of one's own. Saving either uploads an image. With
 * nothing typed the face keeps what it shows by default, the first characters of the group's name.
 */
export function GroupAvatarEditor({ chatId, groupName, busy, onFile, onClose }: {
  chatId: string
  groupName: string
  busy: boolean
  onFile: (file: File) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [text, setText] = useState('')
  const [color, setColor] = useState(() => groupAvatarColor(chatId))
  const fileInput = useRef<HTMLInputElement>(null)
  const shown = text.trim() ? text : groupAvatarDefaultText(groupName)
  const preview = useMemo(() => ({ __html: groupAvatarSvg({ color, text: shown, fill: 'var(--card)', px: 96 }) }), [color, shown])
  const submit = (file: Promise<File> | File) => { void Promise.resolve(file).then(onFile).then(onClose) }
  return (
    <Sheet onClose={() => { if (!busy) onClose() }} desktopWidth="min(520px, 100%)" mobileFitContent testId="group-avatar-editor" ariaLabel={t('group.settings.avatarEditor.title')}>
      <div className="flex flex-col gap-4 !p-5">
        <h3 className="m-0 text-[length:var(--font-heading)] font-semibold text-[var(--text-primary)]">{t('group.settings.avatarEditor.title')}</h3>
        <div className="flex gap-6 max-sm:flex-col max-sm:items-center">
          <div className="relative h-24 w-24 shrink-0">
            <span data-testid="group-avatar-preview" className="block h-24 w-24"
              dangerouslySetInnerHTML={preview} />
            <Button variant="primary" size="icon" data-testid="group-avatar-upload" disabled={busy} onClick={() => fileInput.current?.click()}
              title={t('group.settings.avatarEditor.upload')} aria-label={t('group.settings.avatarEditor.upload')}
              className="!absolute bottom-0 right-0 h-7 w-7 rounded-full">
              <Camera size={14} />
            </Button>
            <input ref={fileInput} type="file" accept="image/*" hidden
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) submit(file) }} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('group.settings.avatarEditor.text')}</div>
            <input data-testid="group-avatar-text" value={text} onChange={(event) => setText(event.target.value)}
              placeholder={groupAvatarDefaultText(groupName) || t('group.settings.avatarEditor.textPlaceholder')}
              className="h-9 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent !px-3 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
            <div className="!pt-2 text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('group.settings.avatarEditor.color')}</div>
            <div role="radiogroup" aria-label={t('group.settings.avatarEditor.color')} className="flex flex-wrap gap-3">
              {GROUP_AVATAR_COLORS.map((one) => (
                <Button key={one} variant="ghost" size="icon" role="radio" aria-checked={one === color} aria-label={one} data-color={one} onClick={() => setColor(one)}
                  className="h-7 w-7 rounded-full text-[var(--color-white)]" style={{ background: one }}>
                  {one === color ? <Check size={14} /> : null}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" data-testid="group-avatar-save" disabled={busy} onClick={() => submit(groupAvatarPng({ color, text: shown }))}>{t('common.save')}</Button>
        </div>
      </div>
    </Sheet>
  )
}
