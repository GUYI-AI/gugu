import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { agentStatusText } from '@/lib/agentStatusText'
import { Avatar } from '@/components/Avatar'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { useShownAgentName } from '@/hooks/useShownAgentName'

/** Session rows share the canonical agent avatar; sessions without an identity use their stable session id. */
export function SessionAvatar({
  agentId,
  sessionId,
  presentation,
  size = 32
}: {
  agentId?: string | null
  sessionId: string
  presentation: AgentStatusPresentation | null
  size?: number
}) {
  const identity = useAvatarIdentity(agentId ?? '')
  const name = useShownAgentName({ name: identity?.display_name ?? (presentation ? agentStatusText(presentation.label) : agentStatusText('none')), createdAt: identity?.created_at ?? undefined })
  return (
    <Avatar seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent harnessBadge={false} size={size}
        name={name}
        statusLabel={presentation?.label ?? 'none'} agentStatus={presentation ? displayStatusOf(presentation.tone) : undefined} />
  )
}

/**
 * 同一个外壳画的另一根轴:机器连没连上(live 蓝点)、页头「正在开 / 正在读」的转圈。它们不是 agent 状态,
 * ❌ 不借 agent 状态的颜色。文字由调用方写在旁边,这里只画形。
 */
/** asleep = #7199 休眠中的云电脑:live 空心圈(❌ 退成离线那一档)。 */
export function LiveGlyph({ state }: { state: 'online' | 'offline' | 'busy' | 'asleep' }) {
  return (
    <span className="gg-aw-glyph" data-live={state} aria-hidden="true" data-testid="agent-watch-live-glyph">
      <span className="gg-aw-glyph-inner" />
    </span>
  )
}
