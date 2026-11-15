import type { HTMLAttributes, ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { Avatar } from '@/components/Avatar';
import { useChatSummariesSelect } from '@/lib/chatSummariesBridge';

type OneListRowProps = {
  name: string;
  /** A chip in front of the preview (the sample's 「示例」). */
  tag?: string;
  time?: string;
  preview: string;
  selected: boolean;
  onOpen: (beside: boolean) => void;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onClick' | 'onKeyDown'>;

/**
 * GUYI-AI/gugu#2548 a row of the one list that is not a conversation yet is drawn as a conversation row: the chat list's
 * own row (ListRow, as ChatRow in components/ChatListPanel.tsx composes it) with its 32px avatar, in the list's 12px
 * gutter (the chat list's own padding, or the tail's after it). Two lines like every conversation row; `preview` '' =
 * nothing said yet (the second line stays, empty).
 */
export function OneListRow({ leading, name, tag, time, preview, selected, onOpen, ...data }: OneListRowProps & { leading: ReactNode }) {
  return (
    <ListRow
      {...data}
      role="button"
      tabIndex={0}
      selected={selected}
      onClick={(event) => onOpen(event.metaKey || event.ctrlKey)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(false);
      }}
      leading={leading}
      title={name}
      meta={time}
      subtitle={tag ? <><Chip>{tag}</Chip>{' '}{preview}</> : preview}
    />
  );
}

/**
 * A project in the one list wears the face a group does: its project group's (the picture that group set included)
 * when it has one, else one drawn from its own id and name. For the projects that have no project
 * group chat yet and for the sample project. Not a new row: those pieces fed without a chat.
 */
export function OneListProjectRow({ faceId, ...row }: OneListRowProps & {
  /** Whose face: the project group's chat id, or the project's own id while it has no group. */
  faceId: string;
}) {
  const picture = useChatSummariesSelect((summaries) => summaries.get(faceId)?.avatar ?? null);
  return <OneListRow leading={<Avatar variant="group" name={row.name} seed={faceId} avatarUrl={picture} size={32} />} {...row} />;
}
