import { useState } from 'react'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { readMobileShell } from '@/hooks/useMobileShell'
import { isImeComposing } from '@/lib/ime'

/** The shared edit phase for group/topic names and personal aliases. */
export function InlineNameInput({ name, onCommit, onClose, placeholder, allowEmpty = false, maxLength, testId, className = 'w-full' }: {
  name: string
  onCommit: (next: string) => Promise<void>
  onClose: () => void
  placeholder?: string
  allowEmpty?: boolean
  maxLength?: number
  testId?: string
  className?: string
}) {
  const [draft, setDraft] = useState(name)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const commit = async () => {
    if (busy) return
    const next = draft.trim()
    if ((!allowEmpty && !next) || next === name) { onClose(); return }
    setBusy(true)
    setFailed('')
    try {
      await onCommit(next)
      onClose()
    } catch (error) {
      rendererLogger('actions/InlineNameInput').error({ error }, 'action failed')
      setFailed(messageForUser(error))
    } finally {
      setBusy(false)
    }
  }
  return <input
    autoFocus
    className={className}
    data-testid={testId}
    value={draft}
    maxLength={maxLength}
    onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => {
      if (isImeComposing(event)) return
      if (event.key === 'Enter') {
        const phone = readMobileShell()
        event.preventDefault()
        if (phone) event.currentTarget.blur() // onBlur owns this save, including a failed attempt.
        else void commit()
      }
      else if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}
    onBlur={() => void commit()}
    placeholder={placeholder}
    aria-invalid={!!failed || undefined}
    data-rename-failed={failed ? 'true' : undefined}
    title={failed || undefined}
    style={{
      border: 'none', fontSize: 'var(--font-heading)', fontWeight: 600,
      background: 'transparent', outline: 'none',
      color: failed ? 'var(--danger)' : 'var(--text-primary)', padding: 0,
    }}
  />
}
