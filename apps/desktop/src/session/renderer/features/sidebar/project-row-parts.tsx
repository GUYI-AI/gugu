import type { HTMLAttributes, ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar';

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
 * A project in the one list wears the project cover (ProjectFolderAvatar at the sidebar's 32, as every project group row
 * does), for the projects that have no project group chat yet and for the sample project. Not a new row: those pieces fed
 * without a chat.
 */
export function OneListProjectRow({ coverId, ...row }: OneListRowProps & {
  /** Whose cover: the project the row stands for. */
  coverId: string;
}) {
  return <OneListRow leading={<ProjectFolderAvatar coverId={coverId} size={32} />} {...row} />;
}
