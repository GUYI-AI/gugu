import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import type { MentionCandidate } from '@/lib/mention'
import type { MentionTarget } from './useChatDraft'
import type { AgentStatusById } from './agentMentionStatusModels'
import { ComposerNotice } from './ComposerNotice'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'

export function AgentMentionOptionLabel({
  member,
  status,
}: {
  member: MentionCandidate
  status?: AgentDisplayStatus
}) {
  const { t } = useTranslation('messaging')
  // #7199 住在收回着的云端宿主上的 agent 读数是离线,但消息照收、有事宿主自己醒 —— ❌ 说它不在线 / 在休息(owner 10-17)。
  const shownStatus = useShownAgentStatus().status(member.id, status)
  const offline = member.type === 'agent' && shownStatus === 'offline'
  const archived = member.type === 'agent' && shownStatus === 'archived'
  return (
    <span style={{ minWidth: 0, display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span>
        {member.name}
        {member.type === 'agent' && member.ownerDisplayName ? (
          <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
            {t('message.agentOwnerSuffix', { owner: member.ownerDisplayName })}
          </span>
        ) : null}
      </span>
      {offline || archived ? (
        <span data-agent-status-warning={archived ? 'archived' : 'offline'} style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>
          {t(archived ? 'agent.archivedWarning' : 'agent.offlineWarning', { name: member.name })}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The line beside the composer after @-ing an agent: only for an archived one, which will not answer at all.
 * An offline agent is warned about in the @ menu row (AgentMentionOptionLabel) and is not repeated as a bar
 * beside the composer (owner 2026-11-08: no banners for connection state anywhere).
 */
export function AgentMentionSelectionNotice({
  members,
  mentionTargets,
  agentStatuses,
}: {
  members: MentionCandidate[]
  mentionTargets: MentionTarget[]
  agentStatuses: AgentStatusById
}) {
  const { t } = useTranslation('messaging')
  const archived = mentionTargets.map((target) => members.find((member) => member.id === target.userId && member.type === 'agent'))
    .find((member) => member && agentStatuses[member.id] === 'archived')
  if (!archived) return null

  return (
    <ComposerNotice
      data-agent-status-surface="mention-selection"
      data-agent-id={archived.id}
      data-agent-display-status="archived"
      data-agent-status-warning="archived"
    >
      {t('agent.archivedWarning', { name: archived.name })}
    </ComposerNotice>
  )
}
