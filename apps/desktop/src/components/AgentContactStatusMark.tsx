import { CLISpinner } from '@renderer/lib/components/cliSpinner'
import { AgentMarkGlyph } from './AgentMarkGlyph'
import { AgentParkedGlyph } from './AgentParkedGlyph'
import type { AgentContactTone } from './contactAgentTone'
import { agentStatusHasMark } from '@/lib/agentStatusMark'

// An agent's one status mark, wherever a status is drawn (the avatar corner, rows, cards, the session page): running =
// the glyph turning, parked = the glyph held still, needs you = the triangle, error = the "×" circle, offline = the "−"
// circle. Every other state (idle, starting …) draws nothing: the words say it.
export function AgentContactStatusMark({ tone, size = 10, className }: { tone: AgentContactTone | null; size?: number; className?: string }) {
  if (!agentStatusHasMark(tone)) return null // #7199 不画状态的那一格(宿主闲时收回着)也走这里
  if (tone === 'working') return <CLISpinner className={className} />
  if (tone === 'parked') return <AgentParkedGlyph className={className} />
  if (tone === 'needs_user') return <AgentMarkGlyph kind="warn" size={size} className={className} />
  if (tone === 'error') return <AgentMarkGlyph kind="error" size={size} className={className} />
  return <AgentMarkGlyph kind="offline" size={size} className={className} />
}
