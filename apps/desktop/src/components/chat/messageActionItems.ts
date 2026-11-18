import type { TFunction } from 'i18next'
import { Clock, Copy, Download, ExternalLink, GitFork, MessageSquare, Pencil, Pin, Reply, Share, SquareCheck, TextCursorInput, Trash, type IconComponent } from '@/lib/icons'
import { SELECTED_MESSAGE_QUOTES_ENABLED } from '../../lib/messageQuoteRollout'
import { confirmDanger } from '../../lib/confirmDanger'

export type MessageActionTarget = {
  isRetracted: boolean
  content: string | null
  /** Limit the menu to handlers for the captured text selection. */
  hasSelection?: boolean
  onReply?: () => void
  onQuoteSelection?: () => void
  onCopy?: (content?: string) => void
  /** 手机才有:收起菜单,在气泡上原地选字(手机长按就是菜单,平时气泡不能选字)。 */
  onSelectText?: () => void
  onCopyLink?: () => void
  onOpenLink?: () => void
  onForward?: () => void
  onDelete?: () => void
  onDownload?: () => void
  /** 自己发的附件在云端的那份:设为临时(到期删)/ 一直保留。提供才有(file_storage_mark_as 只认上传者本人)。 */
  onKeep?: (keep: 'temporary' | 'permanent') => void
  /** 提供则有「多选」;不提供则隐藏。 */
  onSelect?: () => void
  /** 提供则有「开话题」;话题里不提供(单层不嵌套)。 */
  onOpenTopic?: () => void
  /** The task timeline: quote the text (or the selection) into its composer as markdown. */
  onQuoteToComposer?: () => void
  /** The task timeline: open the file this message carries, the way its card opens it. */
  onOpenFile?: () => void
  /** The task timeline: edit one's own message and resend from there. */
  onEditMessage?: () => void
  /** The task timeline: fork this whole task. */
  onForkTask?: () => void
}

export type MessageActionItem = {
  key: string
  icon: IconComponent
  label: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  /** 桌面菜单里收进「更多」;手机长按的列表平铺,不看这一项。 */
  fold?: true
}

/** 一条消息能做的事。右键 / ⋯ / 长按 / 文件预览共用,按提供的 handler 取适合当前场景的动作。 */
export function messageActionItems(input: MessageActionTarget, t: TFunction<'messaging'>): MessageActionItem[] {
  const target: MessageActionTarget = input.hasSelection ? {
    isRetracted: input.isRetracted, content: input.content,
    onReply: selectionReply(input), onQuoteToComposer: input.onQuoteToComposer, onCopy: input.onCopy,
    onCopyLink: input.onCopyLink, onOpenLink: input.onOpenLink,
  } : input
  const hasContent = !!target.content && !target.isRetracted
  // Ordered by session/shared/menu-table.ts @@@menu-order. No click data exists; each row says why it sits where it does.
  const items: (MessageActionItem | false)[] = [
    // Reply: many times a day in any group.
    !!target.onReply && { key: 'reply', icon: Reply, label: t('message.actions.reply'), onSelect: target.onReply, disabled: target.isRetracted },
    // Reply to the selected words: offered only while text is selected, which is the reply's own intent.
    SELECTED_MESSAGE_QUOTES_ENABLED && !!target.onQuoteSelection && { key: 'quoteSelection', icon: Reply, label: t('message.actions.quoteSelection'), onSelect: target.onQuoteSelection, disabled: target.isRetracted },
    // Copy: many times a day, mostly to paste into another app.
    !!target.onCopy && { key: 'copy', icon: Copy, label: t('message.actions.copy'), onSelect: target.onCopy, disabled: !hasContent },
    // The task timeline's reply: quote into the composer, as often as reply in a chat.
    !!target.onQuoteToComposer && { key: 'quoteToComposer', icon: Reply, label: t(input.hasSelection ? 'message.actions.quoteSelectionToComposer' : 'message.actions.quoteToComposer'), onSelect: target.onQuoteToComposer, disabled: !hasContent },
    // Phone only: selecting part of a message to copy it, the phone's way to a partial copy.
    !!target.onSelectText && { key: 'selectText', icon: TextCursorInput, label: t('message.actions.selectText'), onSelect: target.onSelectText, disabled: !hasContent },
    // Copy or open a link: offered only when the pointer is on a link; after copy, which keeps its place so the rows a
    // reader knows do not move under a link.
    !!target.onCopyLink && { key: 'copyLink', icon: Copy, label: t('message.actions.copyLink'), onSelect: target.onCopyLink, disabled: target.isRetracted },
    !!target.onOpenLink && { key: 'openLink', icon: ExternalLink, label: t('message.actions.openLink'), onSelect: target.onOpenLink, disabled: target.isRetracted },
    // Forward: daily, sharing a message with another chat.
    !!target.onForward && { key: 'forward', icon: Share, label: t('message.actions.forward'), onSelect: target.onForward, disabled: !hasContent },
    // Open a topic: a few times a week, splitting a thread off a busy group.
    !!target.onOpenTopic && { key: 'openTopic', icon: MessageSquare, label: t('message.actions.openTopic'), onSelect: target.onOpenTopic, disabled: target.isRetracted },
    // A message that carries a file: opening or saving it is why it was right-clicked.
    !!target.onOpenFile && { key: 'openFile', icon: ExternalLink, label: t('message.actions.openFile'), onSelect: target.onOpenFile, disabled: target.isRetracted },
    !!target.onDownload && { key: 'download', icon: Download, label: t('chatArea.filePreview.download'), onSelect: target.onDownload, disabled: target.isRetracted },
    // Edit and resend one's own task message: a few times a day while steering a task.
    !!target.onEditMessage && { key: 'editMessage', icon: Pencil, label: t('message.actions.editMessage'), onSelect: target.onEditMessage },
    // 更多 — fork the whole task: a few times a week at most.
    !!target.onForkTask && { key: 'forkTask', icon: GitFork, label: t('message.actions.forkTask'), onSelect: target.onForkTask, fold: true },
    // 更多 — multi-select: rare, to forward or delete several at once.
    !!target.onSelect && { key: 'select', icon: SquareCheck, label: t('message.actions.select'), onSelect: target.onSelect, fold: true },
    // 更多 — how long one's own attachment is kept: set once in a while, most files keep the default.
    !!target.onKeep && { key: 'keep-temporary', icon: Clock, label: t('message.actions.keepTemporary'), onSelect: () => target.onKeep!('temporary'), disabled: target.isRetracted, fold: true },
    !!target.onKeep && { key: 'keep-permanent', icon: Pin, label: t('message.actions.keepPermanent'), onSelect: () => target.onKeep!('permanent'), disabled: target.isRetracted, fold: true },
    // 更多, last — delete: rare and destructive. It cannot be undone (it may delete for everyone), so it asks first,
    // from every surface this table serves.
    !!target.onDelete && { key: 'delete', icon: Trash, label: t('message.actions.delete'), danger: true, fold: true, onSelect: () => {
      void confirmDanger({ title: t('message.actions.deleteTitle'), description: t('message.actions.deleteConfirm'), confirmLabel: t('message.actions.delete') })
        .then((ok) => { if (ok) target.onDelete!() })
    } },
  ]
  return items.filter((item): item is MessageActionItem => item !== false)
}

/** Until excerpt-aware receivers ship, Reply on a selection keeps its whole-message meaning. */
function selectionReply(target: MessageActionTarget) {
  return SELECTED_MESSAGE_QUOTES_ENABLED ? target.onQuoteSelection ?? target.onReply : target.onReply
}
