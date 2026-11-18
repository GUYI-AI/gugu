import { BODY_COLORS } from '../components/agentAvatar/engine/identity'
import { isBuiltinAgentAvatarUrl, resolveAgentLook, type AgentLook } from '../components/agentAvatar/look'
import { avatarColorIndex } from '@gugu/core/shared/ui/avatarPalette'

/** Follow each generated avatar's existing main colour; uploaded images keep their identity hue. */
export function memberNameHue({ id, avatar, isAgent, assistantLook }: {
  id: string | null
  avatar?: string | null
  isAgent: boolean
  assistantLook?: AgentLook
}): number {
  const identityHue = BODY_COLORS[resolveAgentLook(id, avatar).color].hue
  if (!id?.trim() || (avatar != null && (!isAgent || !isBuiltinAgentAvatarUrl(avatar)))) return identityHue
  if (isAgent && assistantLook) return BODY_COLORS[assistantLook.color].hue
  return BODY_COLORS[avatarColorIndex(id)].hue
}
