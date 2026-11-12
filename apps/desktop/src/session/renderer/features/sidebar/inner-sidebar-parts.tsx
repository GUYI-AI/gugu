import { MoreHorizontal, PanelLeftClose } from '@/lib/icons';
import { useState, type ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { DropdownMenu } from '@/components/ui/Menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { setInnerSidebarFolded } from './inner-sidebar-fold';
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
 * 行尾的东西(「…」、新智能体、收起这一列)由调用方给,摆在行的右端;名字只让出它们那么宽(`trailingButtons` 枚 24px 钮 + 右边 8px)。
 * 它就是这一列顶上那条 40px 的带(#2548 提议稿:和左边列表顶上那一行、正文的页签条平齐),❌ 再在上面垫一条空带;
 * 带里空着的地方照样拖得动窗口(同页签条,按钮自己退订,index.css @@@titlebar-no-drag)。
 */
export function InnerHeadRowLayout({
  headKey,
  name,
  tag,
  avatar,
  active,
  onOpen,
  trailingButtons,
  children,
}: {
  headKey: string;
  name: string;
  tag?: string;
  avatar: ReactNode;
  active: boolean;
  onOpen: () => void;
  /** 行尾几枚钮(`children`),名字给它们让出的宽度按它算。 */
  trailingButtons: number;
  children: ReactNode;
}) {
  return (
    <SidebarMenu className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]">
      <div className="group/head relative w-full" data-inner-head={headKey}>
        <SidebarMenuButton isActive={active} aria-label={name} className="w-full" style={{ paddingInlineEnd: 8 + 24 * trailingButtons }} onClick={onOpen}>
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

/** 头一行最右那枚:收起这一列(#2548 ⑤)。收起是全局的(inner-sidebar-fold);钮是「…」、笔那一种。 */
export function InnerSidebarFoldButton() {
  const { translate } = useSessionMessages();
  const label = translate('sidebar.collapseInner');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" aria-label={label} data-inner-head-fold="" className={sidebarHeaderIconButtonClass} onClick={() => setInnerSidebarFolded(true)}>
            <PanelLeftClose />
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
