import { useDndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { SurfaceBox } from '@renderer/lib/layout/place-in';
import { PANEL_REST, panelRest } from '@renderer/lib/layout/panel-track';
import { PanelToggleIcon } from '@/components/PanelToggleIcon';
import { Maximize2, Minimize2 } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { openPanelItem } from '../chats/chat-tabs/chat-layouts';
import { folderItem } from '../chats/chat-tabs/chat-panel-item';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { openChatWorkspaceNewTab } from './chat-workspace-new-tab';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { escapeIsFree } from '@shared/escape-is-free';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PaneProvider } from './pane-context';
import type { PaneLayoutStore } from './pane-layout-store';
import { TAB_STRIP_NARROW_PX, TabBar, TabStripShell } from './tab-bar';
import { CHAT_TOOL_COMPACT_HEADER_MAX_WIDTH_PX } from './chat-tool-geometry';
import { ChatWorkspaceTabContext } from './chat-workspace-context';

export type ChatWorkspaceChromeProps = {
  actions: ReactNode;
  addTab: ReactNode;
  leading?: ReactNode;
  reserveShellRestoreLane?: boolean;
  leadingReservePx?: number;
  embedded?: boolean;
};

/** The bar the capsule floats in (设计稿 .capbar): 56 high, the card's own white, the capsule centred in it. */
const CAPSULE_BAR_STYLE = { '--tab-strip-height': '56px', '--tab-strip-inset-start': '0px', '--tab-strip-inset-end': '0px', '--tab-strip': 'var(--bg)', '--color-tab-strip': 'var(--bg)' } as CSSProperties;

export const ChatWorkspaceChrome = observer(function ChatWorkspaceChrome({
  layout, heads, inCells, park, anchor, actions, addTab, leading, reserveShellRestoreLane, leadingReservePx, embedded = false,
}: ChatWorkspaceChromeProps & {
  layout: PaneLayoutStore;
  /** The strip's two columns' hosts (@@@placed-surface), and whether pane-tree-view shows them at the heads of their panes' cells. */
  heads: { chat: HTMLElement; tools: HTMLElement };
  inCells: boolean;
  park: RefObject<Element | null>;
  anchor: string; // the workspace's box, as a CSS anchor
}) {
  const { translate } = useSessionMessages();
  const panes = layout.chatWorkspacePanes;
  const mode = layout.chatWorkspaceMode;
  const { focused } = useScreenBlock();
  const dragging = useDndContext().active !== null;
  const header = park; // where the strip's hosts wait while no box shows them: also what the hooks below find the workspace from
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => {
      const workspace = header.current?.closest('[data-chat-tool-workspace]');
      if (!workspace || !focused) return false;
      const target = element?.isConnected ? element : workspace.ownerDocument.activeElement;
      const from = target?.closest('[data-chat-tool-workspace]');
      return embedded ? from === workspace : !from || from === workspace;
    },
    getCommands: () => {
      if (!layout.mainGroup.pane.registry.has('browser')) return [];
      const open = () => { openChatWorkspaceNewTab(layout); };
      const place = layout.mainGroup.pane.ctx.place;
      return [
        { id: 'session.openAddMenu', execute: open },
        ...(place?.kind === 'chat' ? [
          { id: 'session.openBrowser' as const, execute: open },
          { id: 'session.sidebarFiles' as const, execute: () => { openPanelItem(place.chatId, folderItem()); } },
        ] : []),
      ];
    },
  });
  useEffect(() => {
    if (!focused || dragging || mode !== 'full') return;
    const workspace = header.current?.closest('[data-chat-tool-workspace]');
    const ownerDocument = workspace?.ownerDocument;
    if (!ownerDocument || !workspace) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || ownerDocument.fullscreenElement || ownerDocument.documentElement.hasAttribute('data-gugu-dragging') || !escapeIsFree(event.target)) return;
      const target = event.target instanceof Element ? event.target : ownerDocument.activeElement;
      const from = target?.closest('[data-chat-tool-workspace]');
      if (embedded ? from !== workspace : from && from !== workspace) return;
      event.preventDefault();
      layout.setChatToolLayout('split');
    };
    ownerDocument.addEventListener('keydown', keyDown, true);
    return () => ownerDocument.removeEventListener('keydown', keyDown, true);
  }, [dragging, embedded, focused, layout, mode]);
  const chatColumn = useRef<HTMLDivElement>(null);
  // Through a move the conversation strip keeps one look (narrow or not): that of the narrower end, ❌ the width drawn. Only
  // narrow or not is kept: a width would be a new value, and a render, on every frame of a drag.
  const [chatRestNarrow, setChatRestNarrow] = useState<boolean>();
  const tools = panes?.tools;
  // The tools on their way off (hidden): their tabs leave with their page (@@@leaving-panes), ❌ before it.
  const leaving = mode === 'hidden' && !!tools && !layout.narrow && layout.isPaneShown(tools.paneId);
  const divided = (mode === 'split' || leaving) && !!tools && !layout.narrow;
  const toolsFirst = divided && layout.groups[0] === tools;
  // Side by side with the tools on the right, the conversation and the tools are two cards (index.css): each gives half
  // the gutter out of its cell.
  const toolCard = !!layout.chatToolCardPaneId;
  const full = mode === 'full';
  const sharedStrip = full || mode === 'split' && layout.narrow;
  // @@@strip-in-cells — the strip's columns are rendered once each, into hosts: side by side each is the head of its pane's
  // cell, laid out, clipped and faded with the page beneath it; in full view and narrow they are in the row above the pages.
  useLayoutEffect(() => {
    const cell = chatColumn.current?.closest<HTMLElement>('[data-panel-slot], [data-panel-fill]');
    if (!cell || !divided) return setChatRestNarrow(undefined);
    const read = () => { const [rest, grow] = (panelRest.get(cell) ?? '').split(' ').map(Number); setChatRestNarrow(panelRest.get(cell) ? Math.min(rest, rest - grow) < TAB_STRIP_NARROW_PX : undefined); };
    read();
    cell.addEventListener(PANEL_REST, read);
    return () => cell.removeEventListener(PANEL_REST, read);
  }, [divided, inCells]);
  // @@@card-gap — the conversation's half of the gutter closes with the last pixels of the tools' cell. Written on the two
  // boxes (❌ an inherited variable on the workspace: it restyled the whole conversation, owner 11-26「刚弹出来一点点的那一瞬间卡顿」).
  useLayoutEffect(() => {
    const cell = heads.tools.closest<HTMLElement>('[data-panel-slot], [data-panel-fill]');
    const workspace = header.current?.closest<HTMLElement>('[data-chat-tool-workspace]');
    if (!toolCard || !cell || !workspace) return undefined;
    const halfGap = parseFloat(getComputedStyle(workspace).getPropertyValue('--chat-card-half-gap')) || 0;
    const cards = () => [chatColumn.current, [...workspace.querySelectorAll<HTMLElement>('[data-chat-card]')].find((card) => card.closest('[data-chat-tool-workspace]') === workspace)];
    const close = new ResizeObserver(([entry]) => {
      const gap = Math.max(0, Math.min(halfGap, entry.contentRect.width - (leaving ? 0 : 1)));
      for (const card of cards()) if (card) card.style.marginRight = gap < halfGap ? `${gap}px` : '';
    });
    close.observe(cell);
    return () => { close.disconnect(); for (const card of cards()) card?.style.removeProperty('margin-right'); };
  }, [toolCard, heads, leaving, inCells]);
  if (!panes || !mode) return null;
  const { chat } = panes;
  const tab = chat.pane.resolvedTabs.find(({ tabId }) => tabId === layout.primaryChatTabId);
  const Title = tab && chat.pane.registry.has(tab.kind) ? chat.pane.registry.get(tab.kind).TabBarItem : null;
  const toolsShown = full || mode === 'split' || leaving;
  const chatActive = layout.activePaneId === chat.paneId;
  const leadingProps = { leadingSlot: leading, reserveShellRestoreLane, leadingReservePx };
  // The capsule row (no tools shown beside it, also while they go off; nothing merged): every button floats at its top right,
  // the block's and the view's in one row.
  const floating = !full && mode !== 'split';

  const conversationTab = tab && Title ? <PaneProvider group={chat} passive isFocusedPane={chatActive}>
    <ChatWorkspaceTabContext.Provider value={{ role: 'conversation', layout }}>
      <Title tab={{ ...tab, pairRole: undefined, isActive: sharedStrip ? chatActive : tab.isActive }} host={chat.pane} ctx={chat.pane.ctx} />
    </ChatWorkspaceTabContext.Provider>
  </PaneProvider> : null;
  const show = translate('tabs.showToolTabs');
  const hide = translate('tabs.hideToolTabs');
  const tabsVisible = mode === 'split';
  const toggleLabel = tabsVisible ? hide : show;
  const exit = translate('tabs.exitToolFullView');
  const maximize = translate('tabs.enterToolFullView');
  const actionRow = (
    <TabBarActionRow>
      {mode === 'empty' && <PaneProvider group={chat} passive isFocusedPane>{addTab}</PaneProvider>}
      {tabsVisible && tools && !sharedStrip && (
        <Button size="icon-sm" variant="ghost" title={maximize} aria-label={maximize} onClick={() => layout.setChatToolLayout('full')}>
          <Maximize2 className="size-3.5" />
        </Button>
      )}
      {tools && (tabsVisible || mode === 'hidden') && (
        <Button size="icon-sm" variant="ghost" title={toggleLabel} aria-label={toggleLabel} aria-pressed={tabsVisible}
          onClick={() => layout.setChatToolLayout(tabsVisible ? 'hidden' : 'split')}>
          <PanelToggleIcon side="right" open={tabsVisible} className="size-3.5" />
        </Button>
      )}
      {full && (
        <Button size="sm" variant="ghost" className="gap-1 text-xs" title={exit} aria-label={exit} onClick={() => layout.setChatToolLayout('split')}>
          {/* Narrow: icon only, like the tab strip's own exit (index.css), so the conversation and page tabs keep their names. */}
          <Minimize2 className="size-3.5" />{(layout.dimensions?.width ?? Infinity) >= CHAT_TOOL_COMPACT_HEADER_MAX_WIDTH_PX && exit}
        </Button>
      )}
    </TabBarActionRow>
  );
  const chatTitle = !sharedStrip && (
    // 第 16 版 #8:对话自己的那条页签条只剩一颗浮动胶囊(设计稿 .capbar 56 高 / .capsule 居中);在工具旁边它仍是这颗胶囊,❌ 页签。
    <div ref={chatColumn} data-chat-workspace-chat-header="" data-chat-card-head={toolCard ? '' : undefined}
      className="flex min-w-0 flex-1" style={CAPSULE_BAR_STYLE}>
      <div className="min-w-0 flex-1">
      <PaneProvider group={chat} passive isFocusedPane={layout.activePaneId === chat.paneId}>
        <ChatWorkspaceTabContext.Provider value={{ role: 'capsule', layout }}>
          <TabStripShell {...(!toolsFirst ? leadingProps : {})} actionsSlot={floating ? undefined : actions} restNarrow={divided ? chatRestNarrow : undefined}>
            {tab && Title ? <Title tab={tab} host={chat.pane} ctx={chat.pane.ctx} /> : null}
          </TabStripShell>
        </ChatWorkspaceTabContext.Provider>
      </PaneProvider>
      </div>
      {/* The row's buttons close the last column: the tools' strip, or with the tools on the left this one. */}
      {toolsFirst && mode === 'split' && actionRow}
      {/* The capsule row's buttons float and take no width, so the capsule centres on the whole card. Pinned to the workspace's
          corner, ❌ this cell's: they are there from the frame the tools are hidden, ❌ after the tools land. */}
      {floating && <div ref={measureFloatingActions} className="z-10 flex" style={{ position: 'fixed', positionAnchor: anchor, top: 'anchor(top)', right: 'anchor(right)', height: 'var(--tab-strip-height)' } as CSSProperties} data-chat-capsule-actions="">
        <div className="flex [--tabbar-actions-edge-gap:0px]">{actions}</div>{actionRow}
      </div>}
    </div>
  );
  const toolTabs = toolsShown && tools && (
    <div className="flex min-w-0 flex-1" data-chat-tool-strip={divided ? '' : undefined}>
      <div className="min-w-0 flex-1">
        <PaneProvider group={tools} passive isFocusedPane={!sharedStrip || !chatActive}>
          <ChatWorkspaceTabContext.Provider value={{ role: 'tool', layout }}>
            <TabBar toolsOnly tabTrailingSlot={addTab}
              leadingTabsSlot={sharedStrip ? conversationTab : undefined}
              selectedTabId={sharedStrip ? chatActive ? tab?.tabId : tools.pane.resolvedActiveTabId : undefined}
              {...(toolsFirst || sharedStrip ? leadingProps : {})} />
          </ChatWorkspaceTabContext.Provider>
        </PaneProvider>
      </div>
      {/* Only while the tools are shown: hidden, they are on their way off and the buttons are already the header's. */}
      {divided && !toolsFirst && mode === 'split' && actionRow}
    </div>
  );
  return (
    <>
      {!inCells && <div className={sharedStrip ? 'flex min-w-0 shrink-0 bg-tab-strip' : 'relative flex min-w-0 shrink-0'} data-chat-workspace-header={mode} data-chat-tool-shared={toolsShown && sharedStrip ? '' : undefined}>
        <SurfaceBox host={heads.chat} park={park} className="contents" />
        <SurfaceBox host={heads.tools} park={park} className="contents" />
        {sharedStrip && actionRow}
      </div>}
      {chatTitle ? createPortal(chatTitle, heads.chat) : null}
      {toolTabs ? createPortal(toolTabs, heads.tools) : null}
    </>
  );
});

/**
 * The capsule row's floating buttons take no width, so the capsule centred on the card could run under them in a narrow
 * block. Their width is written on the header (--capsule-actions-lane); the capsule's layer keeps that much clear on its right
 * (index.css .conversation-capsule-layer): centred while there is room, never under a button.
 */
function measureFloatingActions(row: HTMLDivElement | null): (() => void) | undefined {
  const header = row?.closest<HTMLElement>('[data-chat-workspace-header]');
  if (!row || !header || typeof ResizeObserver === 'undefined') return undefined;
  const write = () => header.style.setProperty('--capsule-actions-lane', `${row.getBoundingClientRect().width}px`);
  write();
  const observer = new ResizeObserver(write);
  observer.observe(row);
  return () => {
    observer.disconnect();
    header.style.removeProperty('--capsule-actions-lane');
  };
}
