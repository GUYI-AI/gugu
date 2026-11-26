import { useTranslation } from 'react-i18next'
import { agentIcons } from '@gugu/session-plugins/agent-icons'
import { pluginIdForAgentType } from '@gugu/core/agentTypes'
import { useAgentHarnessIdentity } from './useAgentHarnessIdentity'
import { useKnownPhoneAgent } from './useKnownPhoneAgent'

/** An agent's harness as the avatar badge draws it: its type, the plugin's brand glyph and name (手机 Agent / Gagent / 确认中 …). */
export function useAgentHarness(agentId: string | undefined) {
  const type = useAgentHarnessIdentity(agentId)
  const phone = useKnownPhoneAgent(agentId) && type !== 'removed'
  const { t } = useTranslation('messaging')
  const icon = phone ? undefined : agentIcons[pluginIdForAgentType(type)]
  const label = phone ? t('agent.identity.phone') : icon?.alt ?? t(`agent.identity.${type === 'gugu-cloud' ? 'cloud' : type === 'removed' ? 'removed' : type === 'pending' ? 'pending' : 'unavailable'}`)
  return { type, icon, label, phone }
}

/**
 * The harness name a card writes as text (Claude Code / Codex / Antigravity …), the same reading as the badge glyph.
 * null while no harness is known (presence not here yet, removed, the payload names no type): the cell is left out,
 * ❌ a 「正在确认」 placeholder in its place.
 */
export function useAgentHarnessName(agentId: string | undefined): string | null {
  const { type, icon, label, phone } = useAgentHarness(agentId)
  return phone || icon || type === 'gugu-cloud' ? label : null
}
