import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { parseGuguLink, type FilePlace, type GuguLinkTarget, type LinkPlace, type OpenTarget } from '@gugu/core/shared/ui/guguLink'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { TabOpenIntent } from '@shared/view-state'
import { platform } from '../platform'
import { notify } from './notices'
import { readMobileShell } from '../hooks/useMobileShell'

/** One shell request for a resolved target, shared by the main and session renderer roots. */
export const OPEN_LINK_TARGET = 'gugu:open-link-target'
export type SenderFile = { path: string; at?: FilePlace }
export type SenderChatTarget = { kind: 'sender'; userId: string; sourceChatId?: string; file?: SenderFile }
export type LinkNavigation = {
  target: GuguLinkTarget | SenderChatTarget
  /** The message it was clicked in: its chat is where a file's tab waits for the host's answer. */
  message?: MessageItem
  restore?: () => void
  /** A file's name as the click knew it: its waiting tab's title. */
  fileName?: string
  /** An App page that asked (its chat and tab): the file's tab waits beside it, as the page's next page. */
  from?: { chatId: string; tabId: string }
  intent?: TabOpenIntent
  /** The chat the asker named the file in: it must be there. */
  chatId?: string
  resolve(opened?: LinkPlace | 'own'): void
  reject(error: unknown): void
}

/** The person asked for something else before this open arrived: nothing failed, and no notice is owed for it. */
export class OpenSuperseded extends Error { constructor() { super('The file opening was superseded') } }

export type LinkSource = Pick<LinkNavigation, 'message' | 'restore' | 'fileName' | 'from' | 'intent' | 'chatId'>
export function openLinkTarget(target: GuguLinkTarget | SenderChatTarget, source: LinkSource = {}): Promise<LinkPlace | 'own' | void> {
  return new Promise((resolve, reject) => {
    const detail: LinkNavigation = { target, ...source, resolve, reject }
    if (window.dispatchEvent(new CustomEvent(OPEN_LINK_TARGET, { detail, cancelable: true }))) reject(new Error('The chat shell is not ready to open this link'))
  })
}

/** A click is parsed once here; main receives the target, not a URL to parse a second time. */
export function openLink(raw: string | OpenTarget, groupParticipantRequestId?: string, source?: Pick<LinkSource, 'message'>): Promise<boolean> | null {
  const target = typeof raw === 'string' ? parseGuguLink(raw, { supabaseUrl: readMobileShell() ? getSupabaseUrl() : undefined }) : raw
  if (!target) return null
  return groupParticipantRequestId || source ? openTarget(target, groupParticipantRequestId, source) : openTarget(target)
}

export async function openTarget(target: OpenTarget, groupParticipantRequestId?: string, source?: Pick<LinkSource, 'message'>): Promise<boolean> {
  if (target.kind === 'widget') {
    const [{ readMessageReference }, { getCurrentAuthUserId }] = await Promise.all([import('./widgetRegistry'), import('./supabase')])
    const account = await getCurrentAuthUserId()
    const origin = await readMessageReference(target, account)
    if (account !== await getCurrentAuthUserId()) return true
    if (origin.status !== 'readable') throw new Error('Widget reference is unavailable')
    await openLinkTarget({ kind: 'chat', chatId: origin.message.chat_id, messageId: origin.message.id })
    return true
  }
  try {
    const outcome = platform.kind === 'electron'
      ? await (await import('../session/renderer/lib/ipc')).rpc.extensions.openLink({ target, ...(groupParticipantRequestId ? { groupParticipantRequestId } : {}), ...(source ? { source } : {}) })
      : await (await import('../components/appSlot/phoneAppHost')).openPhoneLink(target, source)
    if (outcome.kind === 'not-gugu-link') return false
    if (outcome.kind === 'failed') throw new Error(`${outcome.name}: ${outcome.detail ?? outcome.reason}`)
    return true
  } catch (error) {
    if (target.kind === 'file') throw new Error(await fileFailureMessage(target), { cause: error })
    throw error
  }
}

async function fileFailureMessage(target: Extract<GuguLinkTarget, { kind: 'file' }>): Promise<string> {
  const [{ i18n }, { fileMetadata }] = await Promise.all([
    import('../i18n'), import('./fileAccess'), import('../i18n/registerAssistantCatalog'),
  ])
  const file = await Promise.resolve().then(() => fileMetadata(target.itemId, target.version)).catch(() => null)
  const key = file?.status === 'ready' && file.revision.source === 'local' && file.revision.host_online === false
    ? 'fileHostOffline'
    : file && file.status !== 'ready' ? 'fileMissing' : 'fileOpenFailed'
  return i18n.t(`assistant:links.${key}`)
}

let followed = 0
/**
 * DOM callers claim synchronously; the one promise reports a failure through the existing notice host. A link followed
 * since took its place (a second tap supersedes the first): only the latest one speaks.
 */
export function followLink(raw: string | OpenTarget, source?: Pick<LinkSource, 'message'>): boolean {
  const opened = source ? openLink(raw, undefined, source) : openLink(raw)
  if (!opened) return false
  const asked = ++followed
  void opened.catch((error: unknown) => { if (asked === followed) notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }) })
  return true
}
