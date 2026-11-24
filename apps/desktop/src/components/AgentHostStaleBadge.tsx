import { AgentMarkGlyph } from './AgentMarkGlyph'
import { agentPresenceReadable } from '../lib/agentPresenceStore'
import { useReplica } from '../lib/replica'
import { runtimeCapabilityPolicy } from '../lib/runtimeCapabilityPolicy'
import { useSelect } from '../lib/selectStore'
import { useTranslation } from 'react-i18next'

// @@@ host-stale-badge (#647) — see git history for full context.
// @@@1370 语义透明：原来 ⚠ 含义只藏在 hover title 里（触屏看不到），用户误以为要「改号/重登」。
// 改：① ⚠ 旁加行内短文案「主机旧」（一眼可读、明确指「主机/机器」而非账号）；② title/aria 改写得更清楚
// + 点明「不影响当前使用」以打消「要改号」的误解。注：对正常旧主机的持续误报根因在 DB（NULL→0 的
// COALESCE），属另一半（DB NULL 透传），本改只做前端可见化，不动显示条件。
export function AgentHostStaleBadge({
  agentUserId,
  size = 12,
}: {
  agentUserId: string
  size?: number
}) {
  const { t } = useTranslation('messaging')
  const label = t('agent.hostStale.label')
  const hint = t('agent.hostStale.hint')
  const policy = useReplica(runtimeCapabilityPolicy, [])
  const capability = useSelect(agentPresenceReadable(agentUserId), (state) => (state.payload ? state.payload.hostRuntimeCapability : null))

  // Unknown or unreadable policy, or no capability reported: nothing to flag (an unread policy is logged where it is read).
  if (policy.state !== 'value' || capability === null || capability >= policy.value) return null

  return (
    <span
      data-agent-host-stale={agentUserId}
      title={hint}
      aria-label={hint}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      {/* owner 11-24:「主机旧」也用需要你的那个三角。 */}
      <AgentMarkGlyph kind="warn" size={size} />
      {/* @@@1370 行内短文案：让含义一眼可读（不靠 hover），且明确指「主机」非账号 → 打消「改号」误解。 */}
      <span style={{ fontSize: Math.max(10, size - 2), lineHeight: 1, color: 'var(--text-tertiary)' }}>{label}</span>
    </span>
  )
}
