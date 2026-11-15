import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { displayAgentReferences } from '@/lib/mentionMdast'

/** A quoted message's words as a quote shows them: a composer card by its own text, agent references as `@name`. */
export function quotedContentView(content: string | null | undefined) {
  const card = composerCardPreview(content)
  return { card, text: displayAgentReferences(card?.text ?? content ?? '', (_id, label) => `@${label}`) }
}
