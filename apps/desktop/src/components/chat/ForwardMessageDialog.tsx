import { useCallback, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { chatPickRow, chatPickRows, forwardPreview } from './forwardMessageUtils'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { ChatPickSheet } from './ChatPickSheet'
import { useChatStore } from '../../store/chatContext'
import { useMobileShell } from '../../hooks/useMobileShell'
import { ShareToAppsRow } from '../share/ShareToAppsRow'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { cn } from '@/lib/cn'
import { MessageSquare } from '@/lib/icons'
import { ForwardNoteEditor } from './ForwardNoteEditor'
import type { ForwardNote } from './forwardToChats'

interface ForwardMessageDialogProps {
  // @@@multi-select (#988) - one or many messages to forward. Single-forward passes [msg];
  // batch (multi-select) passes the selected list. The caller (handleForwardTo) fans out
  // messages × targetChatIds, so this dialog only needs them for the preview.
  messages?: MessageItem[]
  /** Forwarding something other than messages (words from a task, files, an App package): what goes, as plain text, one
   * line per piece in reading order; the page shows the last line and 「详情」 shows all. */
  preview?: string
  topRow?: ReactNode
  chats: ChatItem[]
  /** Source chat — excluded from the target list. */
  sourceChatId: string
  /**
   * Forward into every chat picked, with the forwarder's note (may be empty). Rejects to surface an error. `sent` names each
   * chat once it has its copy: it leaves the pick, so sending again after a failure part-way only reaches the rest.
   */
  onForward: (targetChatIds: string[], note: ForwardNote, sent: (chatId: string) => void) => Promise<void>
  onClose: () => void
}

/**
 * Forwarding in two steps. First whom: a tap on a chat goes straight on; 「多选」 switches to ticking several, then 「下一步」.
 * Then the send: to whom, what (one line, 「详情」 for all of it), the note (its @ is the one chat picked), 取消 / 发送.
 */
export function ForwardMessageDialog({ messages = [], preview: subject, topRow, chats, sourceChatId, onForward, onClose }: ForwardMessageDialogProps) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const [several, setSeveral] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [query, setQuery] = useState('')

  const pick = useCallback((id: string) => {
    if (!several) {
      setSelected(new Set([id]))
      setConfirming(true)
      return
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [several])

  const untick = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // @@@5856 转发目标的名字:场所(群 + 话题)用自己的名字,dm/ai 用对端。
  // 写死 kind === 'group' 的后果有两层:话题在列表里是**一行空白**,而且 forwardableChats 用同一个
  // 函数做搜索匹配 ⇒ 按名字**永远搜不到话题**。spec「跨线引用留痕」的出处那一半做了,目的地这一半选不中。
  const forwardTargetName = useCallback(
    (chat: ChatItem) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name),
    [identitiesById],
  )
  const rows = useMemo(
    () => chatPickRows(chats, sourceChatId, query, forwardTargetName, identitiesById),
    [chats, sourceChatId, query, forwardTargetName, identitiesById],
  )

  const labels = { attachment: t('forward.preview.attachment'), card: t('forward.preview.card'), empty: t('forward.preview.empty') }
  const said = (message: MessageItem) => `${identitiesById[message.sender_user_id ?? '']?.display_name ?? ''}：${forwardPreview(message, labels)}`
  const detail = subject ?? messages.map(said).join('\n')
  if (!detail) return null
  const line = subject !== undefined ? subject.split('\n').at(-1) ?? '' : messages.length > 1 ? t('forward.batchPreview', { count: messages.length }) : said(messages[0]!)

  const back = () => {
    setConfirming(false)
    if (!several) setSelected(new Set())
  }
  const targets = chats.filter((chat) => selected.has(chat.id))

  return <>
    <ChatPickSheet
      title={t('forward.title')}
      onClose={onClose}
      testId="forward-message-dialog"
      rows={rows}
      single={!several}
      selected={selected}
      onToggle={pick}
      query={query}
      onQuery={setQuery}
      placeholder={t('forward.searchChats')}
      empty={chats.length <= 1 ? t('forward.noTargets') : t('forward.noResults')}
      top={topRow ?? <ShareToAppsRow messages={messages} onClose={onClose} />}
      headerAction={
        <Button variant={several ? 'primary' : 'secondary'} size="sm" aria-pressed={several} data-testid="forward-several"
          onClick={() => { setSeveral((on) => !on); setSelected(new Set()) }}>
          {t('forward.several')}
        </Button>
      }
      picked={t('forward.selected', { count: selected.size })}
      actionLabel={t('forward.next')}
      onAction={() => setConfirming(true)}
      actionDisabled={selected.size === 0}
    />
    {confirming && targets.length > 0 && (
      <ForwardConfirm targets={targets} name={forwardTargetName} line={line} detail={detail}
        onBack={back} onSend={(note) => onForward(targets.map((chat) => chat.id), note, untick)} onDone={onClose} />
    )}
  </>
}

/** The second step: to whom, what, the note; 取消 goes back to the pick, 发送 forwards. */
function ForwardConfirm({ targets, name, line, detail, onBack, onSend, onDone }: {
  targets: ChatItem[]
  name: (chat: ChatItem) => string
  line: string
  detail: string
  onBack: () => void
  onSend: (note: ForwardNote) => Promise<void>
  onDone: () => void
}) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const { identitiesById } = useChatStore('identitiesById')
  const [note, setNote] = useState<ForwardNote>({ text: '', toUserIds: [] })
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setSending(true)
    setError(null)
    try {
      await onSend(note)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('forward.failed'))
    } finally {
      setSending(false)
    }
  }
  const [only] = targets
  const face = (chat: ChatItem) => {
    const avatar = chatPickRow(chat, name(chat), identitiesById).avatar
    return avatar ? <Avatar {...avatar} size="md" /> : <MessageSquare size={20} className="shrink-0" style={{ color: 'var(--text-tertiary)' }} />
  }
  return (
    <Sheet onClose={onBack} desktopWidth="min(420px, 100%)" mobileFitContent testId="forward-confirm" ariaLabel={t('forward.title')}>
      <div className={cn('flex flex-col gap-3', mobile ? '!p-4' : '!p-5')}>
        <div className="text-[length:var(--font-body)] text-[var(--muted-fg)]">{t('forward.sendTo')}</div>
        {targets.length === 1 && only ? (
          <div className="flex min-w-0 items-center gap-3" data-forward-to={only.id}>
            {face(only)}
            <span className="min-w-0 truncate text-[length:var(--font-body)] font-medium text-[var(--text-primary)]">{name(only)}</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {targets.map((chat) => (
              <div key={chat.id} data-forward-to={chat.id} className="flex w-14 flex-col items-center gap-1" title={name(chat)}>
                {face(chat)}
                <span className="w-full truncate text-center text-[length:var(--font-caption)] text-[var(--muted-fg)]">{name(chat)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-[var(--radius-control)] bg-[var(--bg-secondary)] px-3 py-2 text-[length:var(--font-body)] text-[var(--text-secondary)]" data-testid="forward-preview">
          {open
            ? <div className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap">{detail}</div>
            : <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{line}</span>
                <Button variant="ghost" size="sm" className="shrink-0 !min-h-0 !px-1 !text-[var(--accent)]" data-testid="forward-detail" onClick={() => setOpen(true)}>{t('forward.detail')}</Button>
              </div>}
        </div>
        <ForwardNoteEditor chat={targets.length === 1 ? only ?? null : null} onChange={setNote} />
        {error ? <p role="alert" className="!m-0 text-[length:var(--font-caption)] text-[var(--danger-fg)]">{error}</p> : null}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onBack} data-testid="forward-cancel">{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void send()} disabled={sending} data-testid="forward-send">
            {sending ? t('forward.forwarding') : t('forward.send')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/** The dialog with the live list: subscribes only while it is open. */
export function LiveForwardMessageDialog(props: Omit<ComponentProps<typeof ForwardMessageDialog>, 'chats'>) {
  const { chats } = useChatStore('chats')
  return <ForwardMessageDialog {...props} chats={chats} />
}
