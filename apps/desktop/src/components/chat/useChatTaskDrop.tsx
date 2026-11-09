import { useState } from 'react'
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components'
import { notify } from '@/lib/notices'
import { useSessionMentionDrop } from '../../session/renderer/lib/chat/use-session-mention-drop'
import type { LocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { TaskDropGroupInvite } from './TaskDropGroupInvite'
import type { ChatMessageComposerProps } from './chatComposerModels'

// The title only: the description is a task's (about SSH machines), and a chat takes files, never a folder.
const folderNotice = () => notify({ title: translateSessionMessage('chat.folderDropUnsupportedTitle'), tier: 'error' })

/** A group drop shares the normal mention resolver and the normal member picker. */
export function useChatTaskDrop({ chatId, isGroupChat, groupMembers = [], provider, editorApiRef, enabled, attachFiles }: Pick<ChatMessageComposerProps, 'chatId' | 'isGroupChat' | 'groupMembers'> & {
  provider: LocalSessionMentionProvider
  editorApiRef: { current: PromptEditorRef | null }
  enabled: boolean
  attachFiles: (files: File[]) => void
}) {
  const [invite, setInvite] = useState<{ chatId: string; item: MentionItem } | null>(null)
  if (invite && (invite.chatId !== chatId || !enabled || !isGroupChat)) setInvite(null)
  const drop = useSessionMentionDrop({ provider, editorApiRef, onMentionResolved: (item) => {
    if (!enabled) return false
    if (!isGroupChat || groupMembers.some((member) => `aid:${member.id}` === item.label)) return
    if (chatId) setInvite({ chatId, item })
    return false
  }, attachFiles: (files) => { if (enabled) attachFiles(files) }, dropFolder: folderNotice })
  return { ...drop, onDirectoriesDropped: folderNotice, invitation: invite && invite.chatId === chatId
    ? <TaskDropGroupInvite key={`${invite.chatId}:${invite.item.id}`} chatId={invite.chatId} agentId={invite.item.label.slice('aid:'.length)} onClose={() => setInvite(null)} /> : null }
}
