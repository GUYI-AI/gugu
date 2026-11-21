import { showModal } from '@renderer/lib/modal/modal-provider'
import { i18n } from '../i18n'

/**
 * The one confirmation for a destructive action that cannot be undone from where it was taken (leaving a group,
 * deleting a contact, a conversation, a topic or a message, removing a member or the sample project). Same dialog as the
 * archive confirmation (confirmActionModal), drawn by SessionModalHost (on desktop inside the task page's tree);
 * ❌ window.confirm, ❌ an action that runs without asking. Resolves true only on confirm.
 */
export function confirmDanger(args: { title: string; description: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => showModal('confirmActionModal', {
    title: args.title,
    description: args.description,
    confirmLabel: args.confirmLabel,
    variant: 'destructive',
    onSuccess: () => resolve(true),
    onClose: () => resolve(false),
  }))
}

const tm = (key: string, values?: Record<string, string>) => i18n.t(key, { ns: 'messaging', ...values })
const tc = (key: string, values?: Record<string, string>) => i18n.t(key, { ns: 'contacts', ...values })

/**
 * The confirmation of a conversation's destructive action, one text per action and kind, whichever entry it was taken
 * from: the chat list, contacts, the phone, a topic's members page.
 */
export function confirmConversationAction(action: 'leave-group' | 'delete-chat' | 'remove-contact', kind: string | null, name: string): Promise<boolean> {
  if (action === 'leave-group') return confirmDanger({ title: tm('chatList.leaveGroup'), description: tc('confirmations.leaveGroup'), confirmLabel: tm('chatList.leaveGroup') })
  if (action === 'remove-contact') return confirmDanger({ title: tc('contextMenu.deleteContact'), description: tc('confirmations.deleteContact', { name }), confirmLabel: tc('contextMenu.deleteContact') })
  if (kind === 'topic') return confirmDanger({ title: tm('chatList.deleteTopic'), description: tm('chatList.deleteTopicConfirm', { name }), confirmLabel: tm('chatList.deleteTopic') })
  return confirmDanger({ title: tm('chatList.deleteChat'), description: tm('chatList.deleteChatConfirm', { name }), confirmLabel: tm('chatList.deleteChat') })
}
