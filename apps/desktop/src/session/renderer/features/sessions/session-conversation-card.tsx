import { observer } from 'mobx-react-lite';
import { RotateCcw } from '@/lib/icons';
import { ConversationCard } from '@/components/chat/ConversationCard';
import { Avatar } from '@/components/Avatar';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import type { TabCommand } from '../tabs/tab-bar/tab-commands';
import { useWorkspaceViewModel } from './session-view-context';
import { sessionRegistry } from './stores/session-registry';

/**
 * My agent's card (第 16 版): its name (click to rename, ❌ the harness mark before it, #39), 重启会话 — the tab's own
 * restart command, which asks 「中断并重启」 first (#41) — and 「详情 ›」 beside the conversation.
 */
export const SessionConversationCard = observer(function SessionConversationCard({ sessionId, commands, onClose }: {
  sessionId: string
  commands: TabCommand[]
  onClose: () => void
}) {
  const view = useWorkspaceViewModel();
  const store = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const name = useShownAgentName({ name: store?.data.title ?? '', agentType: store?.data.providerId, createdAt: store?.data.createdAt });
  const reload = commands.find((command) => command.id === 'session:reload');
  if (!store) return null;
  return <ConversationCard
    avatar={<Avatar name={name} seed={sessionId} isAgent size={44} still />}
    name={name}
    onRename={(next) => sessionRegistry.get(sessionId)!.renameSession(sessionId, next)}
    notify={null}
    action={reload ? { icon: <RotateCcw size={16} />, label: reload.label, testId: 'conversation-card-restart', run: () => { onClose(); void reload.run(); } } : null}
    onDetails={() => { onClose(); view.paneLayout.openBeside('session-details', { sessionId }); }}
  />;
});
