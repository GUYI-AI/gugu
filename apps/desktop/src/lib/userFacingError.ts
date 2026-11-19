import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

const CONVERSATION_FAILURES = {
  dm_friendship_required: 'humanDm.friendshipRequired',
  conversation_delete_owner_required: 'conversationDelete.ownerRequired',
  conversation_dm_identity_unverified: 'conversationDelete.identityUnverified',
  conversation_agent_in_use: 'conversationDelete.agentInUse',
  conversation_assistant_in_use: 'conversationDelete.assistantInUse',
  human_group_owner_required: 'conversationDelete.groupOwnerRequired',
  human_group_required: 'conversationDelete.groupRequired',
  group_manager_required: 'conversationDelete.managerRequired',
  group_not_visible: 'conversationDelete.notVisible',
} as const

/** Recognize only the server's stable denial, including persisted attachment/IPC wrappers. */
export function isDmFriendshipRequired(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const value = error as { code?: unknown; hint?: unknown; reason?: unknown }
    if (value.code === 'dm_friendship_required' || value.hint === 'dm_friendship_required') return true
    if (value.reason === 'dm_friendship_required') return true
  }
  const line = String((error as Error)?.message ?? error)
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '').split(/\r?\n/, 1)[0]!.trim()
  return line.replace(/^attachments\/[a-z-]+:\s*/, '') === 'dm_friendship_required'
}

/** The existing UI error boundary preserves the cause and removes sensitive text. */
export function messageForUser(error: unknown): string {
  const line = isDmFriendshipRequired(error) ? 'dm_friendship_required' : safeFailureLine(String((error as Error)?.message ?? error))
  const key = CONVERSATION_FAILURES[line as keyof typeof CONVERSATION_FAILURES]
  return key ? translateSessionMessage(key) : line
}
