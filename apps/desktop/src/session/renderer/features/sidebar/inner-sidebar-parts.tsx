import { MoreHorizontal, PanelLeftClose } from '@/lib/icons';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { DropdownMenu } from '@/components/ui/Menu';
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
 * 头一行:这个群 / 项目自己 —— 头像 + 名字(+ 标签,示例的「示例」),点它回到它的对话。它是这一列的标题,不是列表里的一行:
 * 看着它时 ❌ 选中底色(刘威提议稿 v1 的 .ihead:24px 头像、粗体名字、底下没有底;字号取面板标题那一档 --font-title,稿子的 15px 不在字号阶梯上)。
 * 行尾的东西(「…」、新智能体、收起这一列)由调用方给,摆在行的右端,钮是左边列表顶上那一行(«、会话历史)那一种。
 * 名字只让出看得见的钮那么宽(`trailingButtons` 枚 32px 钮、钮间 4px、右边 8px);「…」静止时不占地方(稿子里这一行只有
 * 笔和收起),指针落到这一行、键盘停在里面或菜单开着时它才展开,名字再让出它那一格。没有「…」的头一行(`hoverMenu` 关)❌ 让那一格。
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
  hoverMenu = true,
  children,
}: {
  headKey: string;
  name: string;
  tag?: string;
  avatar: ReactNode;
  active: boolean;
  onOpen: () => void;
  /** 行尾常驻的钮有几枚(不算悬停才出的「…」),名字给它们让出的宽度按它算。 */
  trailingButtons: number;
  /** 行尾有没有悬停才出的「…」(InnerHeadActionsMenu)。 */
  hoverMenu?: boolean;
  children: ReactNode;
}) {
  const reserve = 8 + HEAD_BUTTON_PX * trailingButtons + HEAD_BUTTON_GAP_PX * Math.max(0, trailingButtons - 1);
  const reserveShown = hoverMenu ? reserve + HEAD_BUTTON_PX + HEAD_BUTTON_GAP_PX : reserve;
  return (
    <SidebarMenu className="flex h-10 shrink-0 items-center [-webkit-app-region:drag]">
      <div
        className="group/head relative w-full [--head-reserve:var(--head-reserve-rest)] focus-within:[--head-reserve:var(--head-reserve-shown)] hover:[--head-reserve:var(--head-reserve-shown)] has-[[aria-expanded=true]]:[--head-reserve:var(--head-reserve-shown)]"
        style={{ '--head-reserve-rest': `${reserve}px`, '--head-reserve-shown': `${reserveShown}px` } as CSSProperties}
        data-inner-head={headKey}
      >
        <SidebarMenuButton
          aria-label={name}
          aria-current={active ? 'page' : undefined}
          className="w-full"
          style={{ paddingInlineEnd: 'var(--head-reserve)' }}
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

/**
 * 头一行的「…」:悬停才出(键盘停在这一行、菜单开着时也在),点开是 `children` 那几项。静止时宽 0、不占地方
 * (外面那一格收成 0,连同它和下一枚之间那 4px),钮还在,键盘照样走得到。
 */
export function InnerHeadActionsMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="-me-1 flex w-0 overflow-hidden transition-[width,margin] group-focus-within/head:me-0 group-focus-within/head:w-8 group-hover/head:me-0 group-hover/head:w-8 has-[[aria-expanded=true]]:me-0 has-[[aria-expanded=true]]:w-8">
      <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
        <Tooltip>
          <DropdownMenu.Trigger
            render={
              <TooltipTrigger
                render={
                  <IconButton
                    size="md"
                    tone="strong"
                    aria-label={label}
                    data-inner-head-actions=""
                    className="opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 aria-expanded:opacity-100"
                  >
                    <MoreHorizontal />
                  </IconButton>
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
    </span>
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
          <IconButton size="md" tone="strong" aria-label={label} data-inner-head-fold="" onClick={() => setInnerSidebarFolded(true)}>
            <PanelLeftClose />
          </IconButton>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
