import type { MemberProfileChatTarget } from '../MemberProfileCard'

/**
 * What a shell hands the native conversation it draws for the assistant: open a member's chat, open a file an agent sent.
 * (The built-in assistant page's conversation column was here; the assistant's page is its App now.)
 */
export type AssistantChatHandlers = {
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onOpenSessionpageAgentFile?: (agentUserId: string, path: string) => Promise<void>
}
