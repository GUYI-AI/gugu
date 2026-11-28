import { BODY_COLORS } from '../components/assistantFigure/engine/identity'
import { isLookAvatarUrl, resolveAssistantLook, type AssistantLook } from '../components/assistantFigure/look'
import { avatarColorIndex } from '@gugu/core/shared/ui/avatarPalette'

/** Follow each generated avatar's existing main colour; uploaded images keep their identity hue. */
export function memberNameHue({ id, avatar, isAgent, assistantLook }: {
  id: string | null
  avatar?: string | null
  isAgent: boolean
  assistantLook?: AssistantLook
}): number {
  const identityHue = BODY_COLORS[resolveAssistantLook(id, avatar).color].hue
  if (!id?.trim() || (avatar != null && (!isAgent || !isLookAvatarUrl(avatar)))) return identityHue
  if (isAgent && assistantLook) return BODY_COLORS[assistantLook.color].hue
  return BODY_COLORS[avatarColorIndex(id)].hue
}
