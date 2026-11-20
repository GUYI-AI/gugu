import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { AgentParkedGlyph } from './AgentParkedGlyph'
import { agentContactRowDotClass, type AgentContactTone } from './contactAgentTone'

export function AgentContactStatusMark({ tone }: { tone: AgentContactTone | null }) {
  if (tone === null) return null // #7199 不画状态的那一格(宿主闲时收回着)
  if (tone === 'needs_user') return <AgentNeedsUserGlyph size={8} />
  if (tone === 'parked') return <AgentParkedGlyph />
  return <span className={agentContactRowDotClass(tone)} aria-hidden="true" />
}
