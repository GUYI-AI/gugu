import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { AssistantFigure } from '../assistantFigure/AssistantFigure'
import { colorSlug } from '../assistantFigure/look'
import { useAssistantLook } from '../assistantFigure/useAssistantLook'
import { useAssistantPoster } from '../assistantFigure/posters'

/** The assistant's face in `<Avatar>`: the animated figure, or its still poster in dense rows. */
export function AssistantDefaultAvatar({ id, avatar, name, size, still = false, hoverPoke, state, canvasPaddingX }: {
  id: string
  avatar?: string | null
  name: string
  size: number
  still?: boolean
  hoverPoke?: boolean
  canvasPaddingX?: number
  state?: AgentStatusLabel | null
}) {
  return still ? <AssistantStill id={id} avatar={avatar} name={name} size={size} />
    : <AssistantFigure id={id} avatar={avatar} name={name} size={size} hoverPoke={hoverPoke} state={state} canvasPaddingX={canvasPaddingX} />
}

function AssistantStill({ id, avatar, name, size }: { id: string; avatar?: string | null; name: string; size: number }) {
  const resolved = useAssistantLook(id, undefined, avatar)
  const poster = useAssistantPoster(resolved)
  return <img src={poster} alt={name} aria-label={name} draggable={false} data-assistant-figure-still={colorSlug(resolved.color)}
    width={size} height={size} className="block shrink-0 object-contain" />
}
