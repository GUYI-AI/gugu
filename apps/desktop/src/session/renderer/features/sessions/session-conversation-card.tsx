import { observer } from 'mobx-react-lite';
import { RotateCcw } from '@/lib/icons';
import { ConversationCard } from '@/components/chat/ConversationCard';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { sessionAgentBindings } from './stores/session-agent-bindings';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import type { TabCommand } from '../tabs/tab-bar/tab-commands';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { sessionRegistry } from './stores/session-registry';

/**
 * My agent's card (第 16 版): its name (click to rename, ❌ the harness mark before it, #39), 重启会话 — the tab's own
 * restart command, which asks 「中断并重启」 first (#41) — and 「详情 ›」 beside the conversation.
 */
export const SessionConversationCard = observer(function SessionConversationCard({ page, sessionId, commands, onClose }: {
  /** The session page the tab is in: 详情 opens beside it there. */
  page: Pick<SessionTabContext, 'projectId' | 'sessionId'>
  sessionId: string
  commands: TabCommand[]
  onClose: () => void
}) {
  const store = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const name = useShownAgentName({ name: store?.data.title ?? '', agentType: store?.data.providerId, createdAt: store?.data.createdAt });
  // The same avatar as its row in the list (SessionAvatar): its identity's picture, ❌ the harness badge (#39).
  const agentId = sessionAgentBindings.bindingFor(sessionId)?.agentUserId;
  const identity = useAvatarIdentity(agentId ?? '');
  const reload = commands.find((command) => command.id === 'session:reload');
  if (!store) return null;
  return <ConversationCard
    avatar={<Avatar name={name} seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent harnessBadge={false} size={44} still />}
    name={name}
    onRename={(next) => sessionRegistry.get(sessionId)!.renameSession(sessionId, next)}
    notify={null}
    action={reload ? { icon: <RotateCcw size={16} />, label: reload.label, testId: 'conversation-card-restart', run: () => { onClose(); void reload.run(); } } : null}
    onDetails={() => { onClose(); void import('./open-session-details').then(({ openSessionDetails }) => openSessionDetails(page, sessionId)); }}
  />;
});
