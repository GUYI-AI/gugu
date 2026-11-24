import { CLISpinner } from '@renderer/lib/components/cliSpinner'
import { AgentNeedsUserGlyph } from './AgentNeedsUserGlyph'
import { AgentParkedGlyph } from './AgentParkedGlyph'
import { agentContactRowDotClass, type AgentContactTone } from './contactAgentTone'

// 同头像角标一套(Avatar.tsx @@@avatar-status-corner):运行中 = 字形在转、后台运行中 = 字形停住、需要你 = 感叹号、
// 出错了 = 红点;其余(在线、不在线、确认中 …)不画,那一句字已经说了。
export function AgentContactStatusMark({ tone }: { tone: AgentContactTone | null }) {
  if (tone === 'working') return <CLISpinner />
  if (tone === 'parked') return <AgentParkedGlyph />
  if (tone === 'needs_user') return <AgentNeedsUserGlyph size={8} />
  if (tone === 'error') return <span className={agentContactRowDotClass(tone)} aria-hidden="true" />
  return null // #7199 不画状态的那一格(宿主闲时收回着)也走这里
}
