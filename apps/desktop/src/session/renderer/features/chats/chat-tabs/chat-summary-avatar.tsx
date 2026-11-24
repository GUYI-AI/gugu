import { observer } from 'mobx-react-lite';
import { Avatar } from '@/components/Avatar';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { useChatSummaries } from '@/lib/chatSummariesBridge';

/**
 * A conversation's face on the session side, from the shell's chat summaries: a group's own avatar (else its default
 * face), a person's or agent's profile picture — the same picture its chat-list row shows.
 */
export const ChatSummaryAvatar = observer(function ChatSummaryAvatar({ chatId, size }: { chatId: string; size: number }) {
  const summary = useChatSummaries().get(chatId) ?? null;
  const peer = useAvatarIdentity(summary?.kind === 'group' ? '' : summary?.peerUserId ?? '');
  if (!summary || summary.kind === 'group' || summary.kind === 'topic') {
    return <Avatar name={summary?.name ?? ''} avatarUrl={summary?.avatar} seed={chatId} size={size} variant="group" still />;
  }
  return <Avatar name={summary.name ?? ''} avatarUrl={peer?.avatar} seed={summary.peerUserId ?? chatId} size={size} isAgent={summary.kind === 'ai'} still />;
});
