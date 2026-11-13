import { PanelLeftClose } from '@/lib/icons';
import type { ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { setInnerSidebarFolded } from './inner-sidebar-fold';
import {
  SidebarMenu,
  SidebarMenuButton,
  sidebarGroupHeaderClass,
  sidebarRowContentInsetX,
} from './sidebar-primitives';

// #2548 内层侧栏里几样零件:群 / 项目那一列(inner-sidebar.tsx)与示例项目那一列(sample-inner-sidebar.tsx)画同一个样子。

/** 分区头:贴在滚动区顶上(往下滚时还看得见是哪一段)。 */
export const innerSectionHeaderClass = cn(sidebarGroupHeaderClass, 'sticky top-0 z-10 bg-background');

/** 分区里什么都没有时那一行字。 */
export const innerSectionEmptyClass = 'px-5 pb-2 text-xs text-foreground-muted';

/**
 * 头一行:这个群 / 项目自己 —— 头像 + 名字(+ 标签,示例的「示例」),点它做什么由调用方给(群 / 项目 = 它的信息与设置)。
 * 它是这一列的标题,不是列表里的一行:看着它时 ❌ 选中底色(刘威提议稿 v1 的 .ihead:24px 头像、粗体名字、底下没有底;
 * 字号取面板标题那一档 --font-title,稿子的 15px 不在字号阶梯上)。
 * 行尾的钮(新智能体、收起这一列)由调用方给,摆在行的右端,是左边列表顶上那一行(«、会话历史)那一种;
 * 名字给它们让出 `trailingButtons` 枚 32px 钮、钮间 4px、右边 8px。❌「…」:这一行自己就是进信息与设置的入口。
 * 它就是这一列顶上那条 40px 的带(#2548 提议稿:和左边列表顶上那一行、正文的页签条平齐),❌ 再在上面垫一条空带;
 * 带里空着的地方照样拖得动窗口(同页签条,按钮自己退订,index.css @@@titlebar-no-drag)。
 */
const HEAD_BUTTON_PX = 32;
const HEAD_BUTTON_GAP_PX = 4;

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
  /** 行尾的钮有几枚,名字给它们让出的宽度按它算。 */
  trailingButtons: number;
  children: ReactNode;
}) {
  const reserve = 8 + HEAD_BUTTON_PX * trailingButtons + HEAD_BUTTON_GAP_PX * Math.max(0, trailingButtons - 1);
  return (
    <SidebarMenu className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]">
      <div className="relative w-full" data-inner-head={headKey}>
        <SidebarMenuButton
          aria-label={name}
          aria-current={active ? 'page' : undefined}
          className="w-full"
          style={{ paddingInlineEnd: `${reserve}px` }}
          onClick={onOpen}
        >
          <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
            <span className="flex size-6 shrink-0 items-center justify-center">{avatar}</span>
            <span className="truncate text-[length:var(--font-title)] font-bold text-foreground">{name}</span>
            {tag ? <Chip>{tag}</Chip> : null}
          </span>
        </SidebarMenuButton>
        <span className="absolute inset-y-0 right-2 flex items-center gap-1">{children}</span>
      </div>
    </SidebarMenu>
  );
}

/** 头一行最右那枚:收起这一列(#2548 ⑤)。收起是全局的(inner-sidebar-fold);钮是笔那一种。 */
export function InnerSidebarFoldButton() {
  const { translate } = useSessionMessages();
  const label = translate('sidebar.collapseInner');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton size="md" tone="strong" aria-label={label} data-inner-head-fold="" onClick={() => setInnerSidebarFolded(true)}>
            <PanelLeftClose />
          </IconButton>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
