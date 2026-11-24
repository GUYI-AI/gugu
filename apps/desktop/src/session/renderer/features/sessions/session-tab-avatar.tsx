import { observer } from 'mobx-react-lite';
import { Avatar } from '@/components/Avatar';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { sessionAgentBindings } from './stores/session-agent-bindings';
import { sessionRegistry } from './stores/session-registry';

/** My agent's face for a tab that stands for it (its 详情): the same picture as its row in the list (SessionAvatar). */
export const SessionTabAvatar = observer(function SessionTabAvatar({ sessionId, size }: { sessionId: string; size: number }) {
  const store = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const agentId = sessionAgentBindings.bindingFor(sessionId)?.agentUserId;
  const identity = useAvatarIdentity(agentId ?? '');
  const name = useShownAgentName({ name: store?.data.title ?? '', agentType: store?.data.providerId, createdAt: store?.data.createdAt });
  return <Avatar name={name} seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent size={size} still />;
});
