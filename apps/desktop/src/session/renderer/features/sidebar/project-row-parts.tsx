import type { HTMLAttributes, ReactNode } from 'react';
import { Avatar } from '@/components/Avatar';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// 项目行的零件:本机项目行(project-item)与别的机器上的项目行(#6264,sidebar-remote-project-item)共用,
// 两种行长得一样只因为用的是同一份零件。

/**
 * spec session-page 链6: 收起的项目行上,「有会话在等你」的那颗琥珀点。本机与别的机器上的项目行同一颗。
 */
export function ProjectNeedsYouDot({ count }: { count: number }) {
  const { translate } = useSessionMessages();
  if (count <= 0) return null;
  const label = translate('sidebar.sessionsNeedYou', { count });
  return (
    <span
      aria-label={label}
      title={label}
      className="size-1.5 shrink-0 rounded-[var(--radius-circle,50%)] bg-foreground-warning"
    />
  );
}

/**
 * 项目名 + 挨着它的次级信息(本机:同名歧义的路径 / 告警图标;别的机器:机器名 / 离线)。
 * 宽度不够时次级信息先让给名字。`keepChildren` 反过来:名字先截,后面那枚保持完整 —— 只给示例项目那一行(#709),
 * 它的「示例」是这一行唯一说明「这是示例」的地方,截成两个字母等于没有。
 */
export function ProjectRowTitle({ name, children, keepChildren = false }: { name: ReactNode; children?: ReactNode; keepChildren?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={keepChildren ? 'min-w-0 truncate' : 'max-w-full shrink-0 truncate'}>{name}</span>
      {keepChildren ? <span className="flex shrink-0">{children}</span> : children}
    </span>
  );
}

/**
 * GUYI-AI/gugu#2548 a project in the sidebar as one list is a conversation row: the chat list's own row (ListRow + the
 * group Avatar at the sidebar size, inside the list's 12px gutter), for the projects that have no project group chat yet
 * and for the sample project. Not a new row: the pieces ChatRow (components/ChatListPanel.tsx) composes, fed without a
 * chat. Two lines like every conversation row; `preview` '' = nothing said yet (the second line stays, empty). The
 * avatar is the group one without a picture or members: these groups have neither yet.
 */
export function OneListProjectRow({ name, tag, time, preview, selected, onOpen, ...data }: {
  name: string;
  /** A chip next to the name (the sample's 「示例」). */
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
        leading={<Avatar name={name} size="sm" variant="group" />}
        title={name}
        accessory={tag ? <Chip>{tag}</Chip> : undefined}
        meta={time}
        subtitle={preview}
      />
    </div>
  );
}
