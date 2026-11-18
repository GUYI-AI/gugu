import { i18n } from '../i18n'
import { notify, dismissNotice, type Notice } from './notices'
import { messageForUser } from './userFacingError'
import type { PersonalConversationHiding } from './hideListedConversation'
import type { PersonalConversationUndo } from './undoListedConversation'

const active = new Map<string, { token: symbol; cleanup: () => void }>()

/** A notice owns its Undo action; the durable controller owns retry IDs and reconciliation. */
export function showConversationHideNotice({ accountId, name, receipt, boundary, undo }: {
  accountId: string
  name: string
  receipt: PersonalConversationHiding
  boundary: AbortSignal
  undo: () => Promise<PersonalConversationUndo | undefined>
}) {
  if (boundary.aborted) return
  const key = `conversation-hide:${accountId}:${receipt.chat_id}`
  const t = (label: string) => i18n.t(`chatList.${label}`, { ns: 'messaging', name })
  const token = Symbol()
  let cleanup = () => {}
  let inFlight: Promise<void> | undefined
  const current = () => active.get(key)?.token === token
  const dismiss = () => {
    cleanup()
    if (current()) { active.delete(key); dismissNotice(key) }
  }
  const retire = () => { cleanup(); if (current() && !inFlight) active.delete(key) }
  active.get(key)?.cleanup()
  active.set(key, { token, cleanup: () => cleanup() })
  const present = (notice: Notice) => {
    cleanup()
    if (boundary.aborted || !current()) return
    cleanup = () => boundary.removeEventListener('abort', dismiss)
    boundary.addEventListener('abort', dismiss, { once: true })
    notify({ ...notice, key, onDismiss: retire, onAutoClose: retire })
  }
  const attempt = () => {
    if (boundary.aborted || !current() || inFlight) return
    inFlight = (async () => {
      try {
        const result = await undo()
        if (boundary.aborted || !current()) return
        if (!result) throw new Error('Undoing conversation hiding was not confirmed')
        if (result.restored) dismiss()
        else present({ title: t('undoHideChanged'), tier: 'info' })
      } catch (error) {
        if (boundary.aborted || !current()) return
        present({ title: t('undoHideFailed'), description: messageForUser(error), tier: 'error',
          action: { label: t('undoHideRetry'), onClick: attempt } })
      }
    })().finally(() => { inFlight = undefined; if (boundary.aborted && current()) { cleanup(); active.delete(key) } })
  }
  present({ title: t('hiddenNotice'), duration: 8000, action: { label: t('undoHide'), onClick: attempt } })
}
