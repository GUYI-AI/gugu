import { observer } from 'mobx-react-lite';
import { RotateCcw } from '@/lib/icons';
import { ConversationCard } from '@/components/chat/ConversationCard';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { agentChatOf, setChatRowNotificationLevel, useChatSummaries } from '@/lib/chatSummariesBridge';
import { log } from '@renderer/utils/logger';
import { sessionAgentBindings } from './stores/session-agent-bindings';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import type { TabCommand } from '../tabs/tab-bar/tab-commands';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { openSessionDetails } from './open-session-details';
import { useSessionModelLabel } from './use-session-model-label';
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';
import { sessionRegistry } from './stores/session-registry';

/**
 * My agent's card (第 16 版): its name (click to rename, ❌ the harness mark before it, #39), 重启会话 — the tab's own
 * restart command, which asks 「中断并重启」 first (#41) — and 「详情 ›」 beside the conversation.
 */
export const SessionConversationCard = observer(function SessionConversationCard({ page, sessionId, surface, live, commands, onClose }: {
  /** A live chat's own model and effort (its store), as its composer shows them. */
  live?: { model: string | null; effort: string | null }
  /** Which model catalog its composer reads (acp chat / terminal). */
  surface: SessionpageSessionSurface
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
  // 消息通知 = 聊天列表里这个 agent 那一行(它的私聊)的通知档位,同一个设置(壳经 chatSummariesBridge 登记)。
  useChatSummaries();
  const chat = agentId ? agentChatOf(agentId) : null;
  const modelLabel = useSessionModelLabel(sessionId, surface, live);
  const reload = commands.find((command) => command.id === 'session:reload');
  if (!store) return null;
  return <ConversationCard
    avatar={<Avatar name={name} seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent size={44} still />}
    name={name}
    subtitle={modelLabel}
    onRename={(next) => sessionRegistry.get(sessionId)!.renameSession(sessionId, next)}
    notify={chat ? { on: chat.summary.notificationLevel !== 'none', set: (on) => void setChatRowNotificationLevel(chat.chatId, on ? 'all' : 'none')
      .catch((error: unknown) => log.error('[conversation-card] notification level failed', { error: error instanceof Error ? error.message : String(error) })) } : null}
    action={reload ? { icon: <RotateCcw size={16} />, label: reload.label, testId: 'conversation-card-restart', run: () => { onClose(); void reload.run(); } } : null}
    onDetails={() => { onClose(); openSessionDetails(page, sessionId); }}
  />;
});
