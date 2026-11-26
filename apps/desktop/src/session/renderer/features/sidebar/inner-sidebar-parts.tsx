import './inner-sidebar-head.css';
import { Button } from '@/components/ui/Button';
import { PanelLeft, SquarePen } from '@/lib/icons';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { TITLEBAR_ACTION_SLOT_GAP_PX, TITLEBAR_ACTION_SLOT_WIDTH_PX } from '@/lib/window-chrome';
import { Button as TabStripButton } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { setInnerSidebarFolded } from './inner-sidebar-fold';
import {
  SidebarMenu,
  SidebarMenuButton,
  sidebarRowContentInsetX,
} from './sidebar-primitives';

// #2548 内层侧栏里几样零件:群 / 项目那一列(inner-sidebar.tsx)与示例项目那一列(sample-inner-sidebar.tsx)画同一个样子。

/**
 * @@@inner-modules (owner 11-26, direction A, GUYI-AI/gugu-dev#1515): the column's modules ("My topics", "My agents"; a future
 * pinned / members / schedule module is one more entry) in one ordered list, drawn as one floating panel inside the group's
 * card (inner-sidebar-head.css [data-inner-module-stack]). The head row is not a module: it stays on the card as the group's
 * title. `open` = the one module opened in place (the topics' "All"): it takes the panel and the others step aside.
 */
export type InnerModule = { id: string; node: ReactNode };
export function InnerModuleStack({ modules, open = null }: { modules: readonly InnerModule[]; open?: string | null }) {
  const shown = open ? modules.filter((module) => module.id === open) : modules;
  return (
    <div className="min-h-0 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll" data-inner-module-stack="">
      {shown.map((module) => <Fragment key={module.id}>{module.node}</Fragment>)}
    </div>
  );
}

/** 分区里什么都没有时那一行字。 */
export const innerSectionEmptyClass = 'ms-2 px-2 py-1 text-[length:var(--font-caption)] leading-[18px] text-foreground-muted';

/**
 * 头一行:这个群 / 项目自己 —— 头像 + 名字(+ 标签,示例的「示例」),点它做什么由调用方给(群 / 项目 = 回到它的主群聊)。
 * 群 / 项目的两行头部共用一块悬停底，创建按钮和行尾按钮是独立入口。标题用 aria-current 表示当前页。
 * 标题用面板的粗体字号 --font-title。
 * 行尾的钮(收起这一列)由调用方给,摆在行的右端,是左边列表顶上那一行(«、会话历史)那一种;
 * 名字给它们让出 `trailingButtons` 枚 28px 钮、钮间 4px、右边 8px。❌ 悬停「⋯」(第 16 版稿:栏顶块只有头像、名字、创建;群的那些项在详情页里)。
 * 没有创建入口时是这一列顶上那条 40px 的带(#2548 提议稿:和左边列表顶上那一行、正文的页签条平齐),❌ 再在上面垫一条空带;
 * 带里空着的地方照样拖得动窗口(同页签条,按钮自己退订,index.css @@@titlebar-no-drag)。
 */
// 钮取顶栏那一档(28):收起后浮出的展开钮(ListColumnToggle)就是这一档,收起前后同一枚大小,❌ 32 一点就缩。
const HEAD_BUTTON_PX = TITLEBAR_ACTION_SLOT_WIDTH_PX;
const HEAD_BUTTON_GAP_PX = TITLEBAR_ACTION_SLOT_GAP_PX;

export function InnerHeadRowLayout({
  headKey,
  name,
  tag,
  avatar,
  active,
  onOpen,
  trailingButtons,
  createAction,
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
  createAction?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  const reserve = 8 + HEAD_BUTTON_PX * trailingButtons + HEAD_BUTTON_GAP_PX * Math.max(0, trailingButtons - 1);
  return (
    <SidebarMenu className={cn("flex h-10 shrink-0 items-center [-webkit-app-region:drag]", createAction && "gg-inner-head-double")}>
      <div
        className="group/head relative w-full"
        style={{ '--head-reserve': `${reserve}px` } as CSSProperties}
        data-inner-head={headKey}
      >
        <SidebarMenuButton
          aria-label={name}
          aria-current={active ? 'page' : undefined}
          data-inner-head-open=""
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
        {createAction ? <Button variant="ghost" size="sm" className="gg-inner-head-create window-no-drag-region" data-inner-head-create="" onClick={createAction.onClick}><SquarePen size={14} /><span>{createAction.label}</span></Button> : null}
        <span className="absolute inset-y-0 right-2 flex items-center gap-1" data-inner-head-actions="">
          {children}
        </span>
      </div>
    </SidebarMenu>
  );
}

/** 头一行最右那枚，收起这一列（#2548 ⑤）。 */
export function InnerSidebarFoldButton() {
  const { translate } = useSessionMessages();
  const label = translate('sidebar.collapseInner');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <TabStripButton size="icon-sm" variant="ghost" className="window-no-drag-region" aria-label={label} data-inner-head-fold="" onClick={() => setInnerSidebarFolded(true)}>
            <PanelLeft />
          </TabStripButton>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
