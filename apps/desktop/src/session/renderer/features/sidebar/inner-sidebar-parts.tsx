import { MoreHorizontal } from '@/lib/icons';
import { useState, type ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { DropdownMenu } from '@/components/ui/Menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import {
  SidebarMenu,
  SidebarMenuButton,
  sidebarGroupHeaderClass,
  sidebarHeaderIconButtonClass,
  sidebarRowContentInsetX,
} from './sidebar-primitives';

// #2548 内层侧栏里几样零件:群 / 项目那一列(inner-sidebar.tsx)与示例项目那一列(sample-inner-sidebar.tsx)画同一个样子。

/** 分区头:贴在滚动区顶上(往下滚时还看得见是哪一段)。 */
export const innerSectionHeaderClass = cn(sidebarGroupHeaderClass, 'sticky top-0 z-10 bg-background');

/** 分区里什么都没有时那一行字。 */
export const innerSectionEmptyClass = 'px-5 pb-2 text-xs text-foreground-muted';

/**
 * 头一行:这个群 / 项目自己 —— 头像 + 名字(+ 标签,示例的「示例」),点它回到它的对话(看着它时选中)。
 * 行尾的东西(未读、「…」、新智能体)由调用方给,摆在行的右端。
 */
export function InnerHeadRowLayout({
  headKey,
  name,
  tag,
  avatar,
  active,
  onOpen,
  children,
}: {
  headKey: string;
  name: string;
  tag?: string;
  avatar: ReactNode;
  active: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <SidebarMenu className="shrink-0 pt-2 pb-1">
      <div className="group/head relative" data-inner-head={headKey}>
        <SidebarMenuButton isActive={active} aria-label={name} className="w-full pr-16" onClick={onOpen}>
          <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
            <span className="flex size-5 shrink-0 items-center justify-center">{avatar}</span>
            <span className="truncate font-semibold text-foreground">{name}</span>
            {tag ? <Chip>{tag}</Chip> : null}
          </span>
        </SidebarMenuButton>
        <span className="absolute inset-y-0 right-2 flex items-center">{children}</span>
      </div>
    </SidebarMenu>
  );
}

/** 头一行的「…」:悬停才出(打开着也在),点开是 `children` 那几项。钮是「对话」分区头上那种钮。 */
export function InnerHeadActionsMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <Tooltip>
        <DropdownMenu.Trigger
          render={
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  data-inner-head-actions=""
                  className={cn(
                    sidebarHeaderIconButtonClass,
                    'opacity-0 transition-opacity group-hover/head:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100'
                  )}
                >
                  <MoreHorizontal />
                </button>
              }
            />
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {open ? (
        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-44">
          {children}
        </DropdownMenu.Content>
      ) : null}
    </DropdownMenu.Root>
  );
}
