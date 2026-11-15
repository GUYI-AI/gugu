import type { ChatComposerProps, MentionItem } from '@gugu/session-ui/react/components';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { loadLocalAgentCreationTools, type LocalAgentCreationTool } from '@/lib/agentCreationTools';
import { replica, useReplica, type Reading } from '@/lib/replica';
import { platform } from '@/platform';
import { events } from '@renderer/lib/ipc';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';
import { useCallback, useEffect, useMemo } from 'react';

type RenderMentionIcon = NonNullable<ChatComposerProps['renderMentionIcon']>;

function MentionAvatar({ id, name, role }: { id: string; name: string; role?: MentionItem['role'] | null }) {
  const identityId = id.replace(/^(?:aid|user):/, '');
  const identity = useAvatarIdentity(identityId);
  return <Avatar seed={identityId} name={name} avatarUrl={identity?.avatar}
    isAgent={role ? role === 'agent' : undefined} size={14} harnessBadge={false} still />;
}

/**
 * The agent tools this computer can create agents with (main's plugin reachability; web and mobile have the static
 * catalog). Main says when an agent's capabilities change (`agentCapabilitiesChangedChannel`) and the catalog is read
 * again; otherwise it is current for five minutes. Not kept across restarts (not in the snapshot cap table).
 */
export const agentCreationTools = replica({
  name: 'agentCreationTools',
  scope: 'device',
  read: () => loadLocalAgentCreationTools(platform),
  fresh: 5 * 60_000,
});

let capabilitiesWatch: { users: number; off: () => void } | null = null;
function watchCapabilities(): () => void {
  if (!capabilitiesWatch) {
    const off = events.on(agentCapabilitiesChangedChannel, () => { void agentCreationTools.refresh(); });
    capabilitiesWatch = { users: 0, off };
  }
  const active = capabilitiesWatch;
  active.users += 1;
  return () => {
    if (--active.users > 0) return;
    active.off();
    if (capabilitiesWatch === active) capabilitiesWatch = null;
  };
}

const NO_TOOLS_YET: readonly LocalAgentCreationTool[] = [];

/** The provider and initial task composer share the same Electron tool catalog. */
export function useSessionAgentCreationTools(): {
  /** The catalog as read: unknown until main answers. */
  reading: Reading<readonly LocalAgentCreationTool[]>;
  tools: readonly LocalAgentCreationTool[];
  error: string | null;
  byEngine: ReadonlyMap<string, LocalAgentCreationTool>;
  renderMentionIcon: RenderMentionIcon;
} {
  const reading = useReplica(agentCreationTools, []);
  useEffect(() => watchCapabilities(), []);
  // @@@reading-default - not read yet (or failed, said in `error`): no @-mention entries for creating an agent until main answers; the mention menu is a list opened later, nothing drawn as a value
  const tools = reading.state === 'value' ? reading.value : NO_TOOLS_YET;
  const error = reading.state === 'error' ? reading.error.message : null;
  const byEngine = useMemo(() => new Map<string, LocalAgentCreationTool>(tools.map((tool) => [tool.engine, tool])), [tools]);
  const renderMentionIcon = useCallback<RenderMentionIcon>(({ id, label, name, kind, role }) =>
    kind === 'custom' ? <MentionAvatar id={id} name={name ?? label} role={role} /> : null, []);
  return { reading, tools, error, byEngine, renderMentionIcon };
}
