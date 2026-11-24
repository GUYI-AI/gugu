import type { ChatComposerProps, MentionItem } from '@gugu/session-ui/react/components';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { loadLocalAgentCreationTools, type LocalAgentCreationTool } from '@/lib/agentCreationTools';
import { replica, useReplica } from '@/lib/replica';
import { platform } from '@/platform';
import { events } from '@renderer/lib/ipc';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';
import { useCallback, useMemo } from 'react';

type RenderMentionIcon = NonNullable<ChatComposerProps['renderMentionIcon']>;

function MentionAvatar({ id, name, role }: { id: string; name: string; role?: MentionItem['role'] | null }) {
  const identityId = id.replace(/^(?:aid|user):/, '');
  const identity = useAvatarIdentity(identityId);
  return <Avatar seed={identityId} name={name} avatarUrl={identity?.avatar}
    isAgent={role ? role === 'agent' : undefined} size={14} still />;
}

/** The agent tools this computer can create agents with (web and mobile have the static catalog). */
export const agentCreationTools = replica({
  name: 'agentCreationTools',
  scope: 'device',
  read: () => loadLocalAgentCreationTools(platform),
  fresh: 5 * 60_000,
  watch: { start: () => events.on(agentCapabilitiesChangedChannel, () => { void agentCreationTools.refresh(); }) },
});


/** The provider and initial task composer share the same Electron tool catalog. */
export function useSessionAgentCreationTools(): {
  /** The catalog by engine; null until main answers (or unreadable): no @-mention entry for creating an agent yet. */
  byEngine: ReadonlyMap<string, LocalAgentCreationTool> | null;
  renderMentionIcon: RenderMentionIcon;
} {
  const reading = useReplica(agentCreationTools, []);
  const tools = reading.state === 'value' ? reading.value : null;
  const byEngine = useMemo(() => (tools ? new Map<string, LocalAgentCreationTool>(tools.map((tool) => [tool.engine, tool])) : null), [tools]);
  const renderMentionIcon = useCallback<RenderMentionIcon>(({ id, label, name, kind, role }) =>
    kind === 'custom' ? <MentionAvatar id={id} name={name ?? label} role={role} /> : null, []);
  return { byEngine, renderMentionIcon };
}
