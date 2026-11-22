import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { Check, Pencil, X } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { nameClampClass } from './contactsPanelStyles'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { IconButton } from '../ui/IconButton'
import { Hint } from '../ui/Tooltip'

/**
 * The agent's name line: its owner renames it in place from a pencil beside the name (the assistant's name in
 * Settings has the same shape). Edits the agent identity, independently of task titles, local aliases and group roles.
 */
export function OwnedAgentNameEditor({ agentId, name, ownerUserId, status, membership, className, clickName, children }: {
  agentId: string
  name: string
  ownerUserId?: string | null
  status?: AgentDisplayStatus
  membership?: string
  /** The host's name typography; the input inherits it. */
  className?: string
  clickName?: boolean
  /** The name as the host draws it. */
  children: ReactNode
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { renameAgent } = useContactsStore()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const canRename = !!user?.id && ownerUserId === user.id && status !== 'removed' && membership !== 'removed'

  const cancel = () => {
    if (pending.current) return
    setDraft(null)
    setError(null)
  }
  const save = async () => {
    if (draft === null || pending.current) return
    const next = draft.trim()
    if (!next) { setError(t('errors.nameRequired')); return }
    // A failed local publication may follow a successful cloud write; allow retrying the same name.
    if (next === name && !error) { cancel(); return }
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      await renameAgent(agentId, next)
      setDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('agentName.failed'))
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  if (clickName && canRename && draft === null) return (
    <button type="button" className={cn('flex min-w-0 cursor-text items-center gap-1 rounded text-left hover:bg-row-hover', className)}
      aria-label={`${t('agentName.editAction')}: ${name}`} title={t('agentName.editAction')}
      onClick={(event) => { event.stopPropagation(); setDraft(name) }}>
      {children}
    </button>
  )
  if (draft === null || !canRename) return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      {/* 名字封顶两行在文字上,❌ 在这个 flex 行上(line-clamp 是 display:-webkit-box)。 */}
      <span className={cn('min-w-0', nameClampClass)} title={typeof children === 'string' ? children : name}>{children}</span>
      {canRename && (
        <Hint label={t('agentName.edit')} side="top">
          <IconButton size="sm" aria-label={t('agentName.edit')} className="shrink-0 text-[var(--muted-fg)]" onClick={() => setDraft(name)}><Pencil /></IconButton>
        </Hint>
      )}
    </div>
  )
  return (
    <div className={cn('flex min-w-0 flex-col', className)} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
    }}>
      <div className="flex min-w-0 items-center gap-1">
        <input
          autoFocus
          aria-label={t('agentName.label')}
          aria-invalid={!!error || undefined}
          className="w-[180px] min-w-0 flex-1 border-0 border-b border-[var(--border)] bg-transparent p-0 text-inherit outline-none [font:inherit] focus:border-[var(--fg)]"
          value={draft}
          disabled={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save() }
          }}
        />
        <IconButton size="sm" aria-label={t('common.save')} disabled={saving} onClick={() => void save()}><Check /></IconButton>
        <IconButton size="sm" aria-label={t('common.cancel')} disabled={saving} onClick={cancel}><X /></IconButton>
      </div>
      {error && <div role="alert" className="text-[length:var(--font-caption)] font-normal text-[var(--danger-fg)]">{error}</div>}
    </div>
  )
}
