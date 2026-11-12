import type { HTMLAttributes } from 'react';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar';

/**
 * GUYI-AI/gugu#2548 a project in the sidebar as one list is a conversation row: the chat list's own row (ListRow inside
 * the list's 12px gutter, as ChatRow in components/ChatListPanel.tsx composes it) wearing the project cover
 * (ProjectFolderAvatar at the sidebar's 32, as every project group row does), for the projects that have no project
 * group chat yet and for the sample project. Not a new row: those pieces fed without a chat. Two lines like every
 * conversation row; `preview` '' = nothing said yet (the second line stays, empty).
 */
export function OneListProjectRow({ name, coverId, tag, time, preview, selected, onOpen, ...data }: {
  name: string;
  /** Whose cover: the project the row stands for. */
  coverId: string;
  /** A chip in front of the preview (the sample's 「示例」). */
  tag?: string;
  time?: string;
  preview: string;
  selected: boolean;
  onOpen: (beside: boolean) => void;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onClick' | 'onKeyDown'>) {
  return (
    <div className="px-3">
      <ListRow
        {...data}
        role="button"
        tabIndex={0}
        selected={selected}
        onClick={(event) => onOpen(event.metaKey || event.ctrlKey)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen(false);
        }}
        leading={<ProjectFolderAvatar coverId={coverId} size={32} />}
        title={name}
        meta={time}
        subtitle={tag ? <><Chip>{tag}</Chip>{' '}{preview}</> : preview}
      />
    </div>
  );
}
