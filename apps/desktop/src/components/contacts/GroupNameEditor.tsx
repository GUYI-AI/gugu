import { useState } from 'react'
import { Check, X } from '@/lib/icons'
import { isImeComposing } from '@/lib/ime'
import { IconButton } from '../contactsDetailControls'
import { ct, inlineInputClass } from './contactsPanelStyles'

/** A group's name, edited in place: Enter saves, Escape cancels; Enter that commits an IME candidate does neither. */
export function GroupNameEditor({
  value,
  placeholder,
  onSave,
  onCancel
}: {
  value: string
  placeholder: string
  onSave: (name: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const name = draft.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await onSave(name)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        className={inlineInputClass}
      />
      <IconButton title={ct('profile.saveAlias')} onClick={save}>
        <Check size={14} />
      </IconButton>
      <IconButton title={ct('common.cancel')} onClick={onCancel}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
