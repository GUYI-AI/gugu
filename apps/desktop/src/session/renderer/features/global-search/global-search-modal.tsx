import type { BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { innerSidebarChat } from '../sidebar/inner-sidebar-anchor'
import { GlobalSearch } from './global-search'

/** The desktop entry: the search panel as a modal, with this device's local tasks. */
export function GlobalSearchModal({ onClose, onSuccess }: BaseModalProps) {
  const anchor = innerSidebarChat.get()
  return <GlobalSearch tasks desktop currentGroupId={anchor?.kind === 'group' ? anchor.chatId : undefined} onClose={onClose} onOpen={() => onSuccess(undefined)} />
}
