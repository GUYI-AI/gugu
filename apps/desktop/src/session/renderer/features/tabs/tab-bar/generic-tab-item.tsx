import { useScreenBlock } from '@renderer/app/screen-block-context';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from '@/lib/icons';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { usePaneContext } from '../pane-context';
import { DraggableTab } from './draggable-tab';
import { PairSeparator } from './pair-separator';
import { TabChip, TabSlot } from './tab-chip';
import type { TabCommand } from './tab-commands';
import { TabContextMenu } from './tab-context-menu';
import { ChatWorkspaceTabContext } from '../chat-workspace-context';
import { Popover } from '@/components/ui/Popover';

/** Props for GenericTabItem — aligns with TabBarItemProps<any> for convenience. */
export interface GenericTabItemProps {
  tab: ResolvedTab;
  host: TabHost;
  ctx: TabViewContext;
  /** Plain visible text; used as the default tooltip base and rename commit basis. */
  label: string;
  /** Drawn instead of the label while it is not known yet (a placeholder the size of a title, ❌ a raw id). */
  unknownLabel?: ReactNode;
  /** Tooltip base when different from label (e.g. full file path). */
  tooltip?: string;
  /** Leading icon slot (file icon, agent icon, spinner). */
  preSlot?: ReactNode;
  /** Muted text after the label (a same-named tab's distinguishing path, the diff group). */
  hint?: string;
  /** A small mark that stays after the title (where a file is kept); unlike statusSlot it never gives way to the close X. */
  markSlot?: ReactNode;
  /** Content shown under the absolutely-positioned close X (e.g. dirty dot, status icon). */
  statusSlot?: ReactNode;
  /** Renders the title in destructive color. */
  hasError?: boolean;
  /** Extra context-menu items placed after the engine commands. */
  kindCommands?: TabCommand[];
  /** Raw editable text prefilled into the rename input (defaults to label). */
  renameValue?: string;
  /** Max character length enforced on the rename input. */
  renameMaxLength?: number;
  /** Double-clicking the conversation's title (standalone or as the workspace's first tab) starts inline rename; a click keeps selecting it. */
  renameOnDoubleClick?: boolean;
  closeDisabled?: boolean;
  /** The conversation's card (第 16 版名片): clicking its tab once it is showing opens this beside the tab. */
  card?: (close: () => void) => ReactNode;
}

/**
 * Single generic tab chip renderer. Owns:
 * - Drag wrapper, click/keyboard interaction, active styling, pane separator
 * - Context menu wrapping
 * - Inline rename (label → input) driven by host.renameRequest
 * - Close button with optional status indicator underneath
 *
 * Each tab kind supplies only its slot config (preSlot, statusSlot, kindCommands)
 * plus label/hint/tooltip/hasError.
 */
export const GenericTabItem = observer(function GenericTabItem({
  tab,
  host,
  ctx,
  label,
  unknownLabel,
  tooltip,
  preSlot,
  hint,
  markSlot,
  statusSlot,
  hasError,
  kindCommands,
  renameValue,
  renameMaxLength,
  renameOnDoubleClick,
  closeDisabled,
  card,
}: GenericTabItemProps) {
  const { translate } = useSessionMessages();
  const { isFocusedPane, pane } = usePaneContext();
  const workspace = useContext(ChatWorkspaceTabContext);
  const workspaceRole = workspace?.role;
  const [isEditing, setIsEditing] = useState(false);
  const committedRef = useRef(false);

  const startRename = useCallback(() => {
    committedRef.current = false;
    window.setTimeout(() => setIsEditing(true), 0);
  }, []);

  const renameRequested = host.renameRequest?.tabId === tab.tabId;
  useEffect(() => {
    if (!renameRequested) return;
    startRename();
    host.clearRenameRequest();
  }, [renameRequested, startRename, host]);

  const commit = useCallback(
    (value: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      let next = value.trim();
      if (renameMaxLength != null) next = next.slice(0, renameMaxLength);
      if (next && next !== (renameValue ?? label)) host.commitRename(tab.tabId, next);
      setIsEditing(false);
    },
    [host, label, renameMaxLength, renameValue, tab.tabId]
  );

  const [cardOpen, setCardOpen] = useState(false);
  // 第 16 版:有名片的页签(我的 agent),它的动作在名片和详情里;页签菜单(⋯ / 右键)只留单独成窗、关闭页签这些页签自己的事。
  const menuCommands = card ? [] : kindCommands;
  const cardPopover = card ? (
    <Popover.Root open={cardOpen} modal={false} onOpenChange={setCardOpen}>
      {cardOpen ? <Popover.Portal><Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={8}
        anchor={() => document.querySelector(`[data-tabid="${CSS.escape(tab.tabId)}"]`)}>
        <Popover.Popup aria-label={label}>{card(() => setCardOpen(false))}</Popover.Popup>
      </Popover.Positioner></Popover.Portal> : null}
    </Popover.Root>
  ) : null;
  /** A tab already showing opens its card on click (the 第 16 版 capsule); any other click selects it. */
  const openCardOr = (select: () => void) => () => { if (card && tab.isActive) setCardOpen((open) => !open); else select(); };

  const handleSelect = () => {
    host.setActiveTab(tab.tabId);
    // Container TabBar onClick will return focus to active content for mouse clicks.
    // Keyboard-initiated selection needs an explicit call since onClick won't fire.
  };

  // 页签全屏:关闭钮前一颗「全屏 / 退出全屏」,双击页签同一件事。
  // 盖住的是整个工作区,所以这屏不止一块时每一枚点着的页签都有;只有一块时只给并排着的那一对(全屏才有区别)。
  const place = useScreenBlock();
  const fill = !workspaceRole && tab.isActive ? host.tabFill(tab.tabId, place.blockId !== null && place.multi) : null;
  const fillLabel = fill ? translate(fill.full ? 'tabs.restorePane' : 'tabs.fillPane') : '';
  const fillButton = fill ? (
    <button
      type="button"
      data-testid="tab-fill"
      aria-pressed={fill.full}
      aria-label={fillLabel}
      title={fillLabel}
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-row-hover hover:text-foreground active:bg-row-press"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        fill.toggle();
      }}
    >
      {fill.full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  ) : null;

  const editableTitle = isEditing ? (
      <input
        ref={(el) => {
          el?.focus();
          el?.select();
        }}
        aria-label={translate('task.renameNameLabel')}
        defaultValue={renameValue ?? label}
        maxLength={renameMaxLength}
        className="h-6 max-w-30 min-w-0 rounded bg-background-1 px-1.5 text-sm text-foreground ring-1 ring-foreground/20 outline-none"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(e.currentTarget.value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            committedRef.current = true;
            setIsEditing(false);
          }
        }}
      />
    ) : undefined;

  if (workspaceRole === 'title') {
    return (
      <>
      <TabContextMenu tab={tab} host={host} ctx={ctx} kindCommands={menuCommands} titleMenu>
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-sm font-medium" data-chat-workspace-title="" data-tabid={card ? tab.tabId : undefined}
          onClick={card ? () => setCardOpen((open) => !open) : undefined}
          onDoubleClick={renameOnDoubleClick && !isEditing ? startRename : undefined}>
          {preSlot}
          {editableTitle ?? <span className="truncate" title={tooltip ?? label}>{label}</span>}
          {statusSlot}
        </div>
      </TabContextMenu>
      {/* Outside the title: React bubbles a click in the portaled card up to its parent, which would reopen it. */}
      {cardPopover}
    </>
    );
  }

  if (workspace?.role === 'conversation') {
    const select = () => { workspace.layout.showChatWorkspaceConversation(); pane.focusActiveContent(); };
    return <><TabSlot data-chat-workspace-conversation-tab="" data-tabid={tab.tabId}>
      <TabContextMenu tab={tab} host={host} ctx={ctx} kindCommands={menuCommands} titleMenu>
        <TabChip isActive={tab.isActive} isFocusedPane={isFocusedPane} label={label} title={tooltip ?? label}
          preSlot={preSlot} labelSlot={editableTitle} statusSlot={statusSlot} onClick={openCardOr(select)}
          onDoubleClick={renameOnDoubleClick && !isEditing ? startRename : undefined}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }} />
      </TabContextMenu>
    </TabSlot>{cardPopover}</>;
  }

  const base = tooltip ?? label;
  const fullTitle = base;

  // ⚠️ 嵌套顺序是**几何**的一部分,❌ 别为了「读起来顺」把右键菜单挪回外层:
  // 页签的宽度规矩(平分 / 240 封顶 / 56 下限)写在 <DraggableTab> 内那层 <TabSlot>(.session-tab-slot)上,
  // 而 flex 只认**直接子项**。菜单在外层时,贴条的 flex 子项是菜单那层 trigger(它没有任何
  // flex 设定 = `0 1 auto`,缩不到内容以下),那条宽度规矩整条失效:页签按内容撑开、不肯让位,
  // 把「+」顶出滚动区裁掉(owner:「这个也得修,还挺严重」);同时 .session-tab-slot 之间的
  // 短分隔线是**相邻兄弟**选择器(index.css),被 trigger 隔开后从来没画出来过。
  return (
    <>
    <DraggableTab id={tab.tabId} pairRole={tab.pairRole}>
      {/* 并排的一对:两枚中间那根线指上去就是「拆开」(spec session-page「并排」)。 */}
      {tab.pairRole === 'end' ? (
        <PairSeparator label={translate('tabs.separatePair')} onSeparate={() => host.separatePair()} />
      ) : null}
      <TabContextMenu tab={tab} host={host} ctx={ctx} kindCommands={menuCommands}>
        <TabChip
          isActive={tab.isActive}
          // 并排时两枚都亮着,点着的那一边标题深、另一边浅 —— 与「哪一格握着焦点」同一种明暗(spec session-page「并排」)。
          isFocusedPane={isFocusedPane && (tab.isFocused ?? true)}
          pairRole={tab.pairRole}
          label={label}
          hint={hint}
          title={fullTitle}
          hasError={hasError}
          preSlot={preSlot}
          labelSlot={editableTitle ?? unknownLabel}
          markSlot={markSlot}
          statusSlot={statusSlot}
          actionSlot={fillButton}
          closeLabel={translate('task.closeTab', { label })}
          onClose={closeDisabled ? undefined : () => host.requestCloseTab(tab.tabId)}
          onMouseEnter={() => host.signalActivateIntent(tab.tabId)}
          onClick={openCardOr(handleSelect)}
          onDoubleClick={() => fill?.toggle()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelect();
              // Keyboard selection doesn't bubble as a click, so return focus explicitly.
              pane.focusActiveContent();
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              host.requestCloseTab(tab.tabId);
            }
          }}
          data-tabid={tab.tabId}
        />
        {/* ❌ 这里原本焊了一根通高的 <Separator>：每个页签后面一条到顶到底的竖线，读起来是
            表格而不是页签。Chrome 的分隔线是 16px 短竖线、且自己或邻居被选中/悬浮时消失 ——
            判据在兄弟节点上，只能用 CSS 表达，见 index.css 的 .session-tab-slot。 */}
      </TabContextMenu>
    </DraggableTab>
    {cardPopover}
    </>
  );
});

/**
 * Generic drag ghost for any tab kind.
 */
export function GenericTabDragPreview({ preSlot, label }: { preSlot?: ReactNode; label: string }) {
  // @@@C-14 (Refs #6107) 浮起物只画一次边:抬升本身就说明它在纸上面 ⇒ 去 border,留 lift。
  return (
    <div className="flex cursor-grabbing items-center gap-1.5 rounded-md bg-background-secondary-1 px-2 py-1 text-sm opacity-80 shadow-lift">
      {preSlot}
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
