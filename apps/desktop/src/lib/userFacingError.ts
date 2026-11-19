import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { codexStartupKind, isCodexProviderStartupKind } from '@gugu/core/local/codex-startup-failure.mjs'
import { sessionStartupFailureCopy } from '@/session/renderer/features/sessions/session-input-failure-copy'

const CONVERSATION_FAILURES = {
  conversation_delete_owner_required: 'conversationDelete.ownerRequired',
  conversation_dm_identity_unverified: 'conversationDelete.identityUnverified',
  conversation_agent_in_use: 'conversationDelete.agentInUse',
  conversation_assistant_in_use: 'conversationDelete.assistantInUse',
  human_group_owner_required: 'conversationDelete.groupOwnerRequired',
  human_group_required: 'conversationDelete.groupRequired',
  group_manager_required: 'conversationDelete.managerRequired',
  group_not_visible: 'conversationDelete.notVisible',
} as const

/** The existing UI error boundary preserves the cause and removes sensitive text. */
export function messageForUser(error: unknown): string {
  const kind = codexStartupKind(error)
  if (isCodexProviderStartupKind(kind)) return sessionStartupFailureCopy({ startupReason: kind }, translateSessionMessage)
  const line = safeFailureLine(String((error as Error)?.message ?? error))
  const key = CONVERSATION_FAILURES[line as keyof typeof CONVERSATION_FAILURES]
  return key ? translateSessionMessage(key) : line
}
