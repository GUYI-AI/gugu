import { useDndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Maximize2, Minimize2, PanelRight } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
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
import { TabBar, TabStripShell } from './tab-bar';
import { CHAT_TOOL_COMPACT_HEADER_MAX_WIDTH_PX } from './chat-tool-geometry';
import { ChatWorkspaceTabContext } from './chat-workspace-context';
import type { CutEdge, CutEdgeRelay } from './chat-workspace-edge';

export type ChatWorkspaceChromeProps = {
  actions: ReactNode;
  addTab: ReactNode;
  leading?: ReactNode;
  reserveShellRestoreLane?: boolean;
  leadingReservePx?: number;
  atWindowEdge?: boolean;
  embedded?: boolean;
};

/** The bar the capsule floats in (设计稿 .capbar): 56 high, the card's own white, the capsule centred in it. */
const CAPSULE_BAR_STYLE = { '--tab-strip-height': '56px', '--tab-strip-inset-start': '0px', '--tab-strip-inset-end': '0px', '--tab-strip': 'var(--bg)', '--color-tab-strip': 'var(--bg)' } as CSSProperties;

export const ChatWorkspaceChrome = observer(function ChatWorkspaceChrome({
  layout, edge, actions, addTab, leading, reserveShellRestoreLane, leadingReservePx, atWindowEdge, embedded = false,
}: ChatWorkspaceChromeProps & { layout: PaneLayoutStore; edge?: CutEdgeRelay }) {
  const { translate } = useSessionMessages();
  const panes = layout.chatWorkspacePanes;
  const mode = layout.chatWorkspaceMode;
  const { focused } = useScreenBlock();
  const dragging = useDndContext().active !== null;
  const header = useRef<HTMLDivElement>(null);
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
  const toolColumn = useRef<HTMLDivElement>(null);
  // Divided, the conversation strip's width at rest: its look (narrow or not) follows it, ❌ the width drawn mid-move.
  const [chatRest, setChatRest] = useState<number>();
  const tools = panes?.tools;
  // The tools on their way off (hidden): their tabs leave with their page (@@@leaving-panes), ❌ before it.
  const leaving = mode === 'hidden' && !!tools && !layout.narrow && layout.isPaneShown(tools.paneId);
  const divided = (mode === 'split' || leaving) && !!tools && !layout.narrow;
  const toolsFirst = divided && layout.groups[0] === tools;
  // Side by side with the tools on the right, the conversation and the tools are two cards (index.css): each card gives half
  // the gutter out of its slot, and the conversation's slot ends in the divider's pixel.
  const toolCard = !!layout.chatToolCardPaneId;
  // @@@strip-on-track: divided, the strip's columns are placed on the root cut's first edge as it is drawn. The tools' tabs
  // move as their page beneath does (PanelTrack): at the width they have at rest, on the moving edge, clipped by the strip.
  // The conversation column ends on the edge, its look (narrow or not) that of its width at rest: nothing in the strip
  // changes how it looks mid-move.
  useLayoutEffect(() => {
    const chatNode = chatColumn.current;
    const toolNode = toolColumn.current;
    const workspace = header.current?.closest<HTMLElement>('[data-chat-tool-workspace]');
    const halfGap = workspace ? parseFloat(getComputedStyle(workspace).getPropertyValue('--chat-card-half-gap')) || 0 : 0;
    const place = ({ drawn, from, to, extent }: CutEdge) => {
      if (toolsFirst) {
        const open = Math.max(from, to);
        if (toolNode) Object.assign(toolNode.style, { left: `${drawn - open}px`, width: `${open}px` });
        if (chatNode) chatNode.style.marginInlineStart = `${drawn}px`;
        setChatRest(extent - open);
      } else if (toolCard) {
        // @@@card-head-width - the cards' heads ride the same edge as their bodies, in the same frame (the edge is written as
        // the track draws the slots): the conversation's head ends where its card does (its slot less the divider's pixel —
        // none is drawn while the tools leave — and its right gap), the tools' strip starts where their card does.
        // The conversation's right gap is half the gutter, ❌ more than the tools have left: as they come on or go off the
        // track it closes with them, so the card meets the one-card surface without a jump.
        const divider = leaving ? 0 : 1;
        const gap = Math.max(0, Math.min(halfGap, extent - drawn - divider));
        workspace?.style.setProperty('--chat-card-right-gap', `${gap}px`);
        if (chatNode) chatNode.style.flex = `0 0 ${drawn - divider - gap}px`;
        if (toolNode) Object.assign(toolNode.style, { left: `${drawn - 1}px`, width: `calc(100% - ${Math.min(from, to)}px - var(--chat-card-half-gap))` });
        setChatRest(Math.min(from, to));
      } else {
        if (chatNode) chatNode.style.flex = `0 1 ${drawn}px`;
        if (toolNode) Object.assign(toolNode.style, { left: `${drawn}px`, width: `calc(100% - ${Math.min(from, to)}px)` });
        setChatRest(Math.min(from, to));
      }
    };
    if (divided && edge) return edge.attach(place);
    workspace?.style.removeProperty('--chat-card-right-gap');
    if (chatNode) Object.assign(chatNode.style, { flex: '', marginInlineStart: '' });
    if (toolNode) Object.assign(toolNode.style, { left: '', width: '' });
    setChatRest(undefined);
    return undefined;
  });
  if (!panes || !mode) return null;
  const { chat } = panes;
  const tab = chat.pane.resolvedTabs.find(({ tabId }) => tabId === layout.primaryChatTabId);
  const Title = tab && chat.pane.registry.has(tab.kind) ? chat.pane.registry.get(tab.kind).TabBarItem : null;
  const full = mode === 'full';
  const toolsShown = full || mode === 'split' || leaving;
  const sharedStrip = full || mode === 'split' && layout.narrow;
  const chatActive = layout.activePaneId === chat.paneId;
  const leadingProps = { leadingSlot: leading, reserveShellRestoreLane, leadingReservePx };

  const conversationTab = tab && Title ? <PaneProvider group={chat} passive isFocusedPane={chatActive}>
    <ChatWorkspaceTabContext.Provider value={{ role: 'conversation', layout }}>
      <Title tab={{ ...tab, pairRole: undefined, isActive: sharedStrip ? chatActive : tab.isActive }} host={chat.pane} ctx={chat.pane.ctx} />
    </ChatWorkspaceTabContext.Provider>
  </PaneProvider> : null;
  const chatTitle = !sharedStrip && (
    // 第 16 版 #8:对话自己的那条页签条只剩一颗浮动胶囊(设计稿 .capbar 56 高 / .capsule 居中);在工具旁边它仍是这颗胶囊,❌ 页签。
    // Beside the tools as a card its width is placed on the cut's edge (place, above); else it fills the row.
    <div ref={chatColumn} data-chat-workspace-chat-header="" data-chat-card-head={toolCard ? '' : undefined}
      className={toolCard ? 'min-w-0 flex-none' : 'min-w-0 flex-1'} style={CAPSULE_BAR_STYLE}>
      <PaneProvider group={chat} passive isFocusedPane={layout.activePaneId === chat.paneId}>
        <ChatWorkspaceTabContext.Provider value={{ role: 'capsule', layout }}>
          <TabStripShell {...(!toolsFirst ? leadingProps : {})} actionsSlot={actions} restWidth={divided ? chatRest : undefined}>
            {tab && Title ? <Title tab={tab} host={chat.pane} ctx={chat.pane.ctx} /> : null}
          </TabStripShell>
        </ChatWorkspaceTabContext.Provider>
      </PaneProvider>
    </div>
  );
  const show = translate('tabs.showToolTabs');
  const hide = translate('tabs.hideToolTabs');
  const tabsVisible = mode === 'split';
  const toggleLabel = tabsVisible ? hide : show;
  const exit = translate('tabs.exitToolFullView');
  const maximize = translate('tabs.enterToolFullView');
  const actionRow = (
    <TabBarActionRow atWindowEdge={!!atWindowEdge}>
      {mode === 'empty' && <PaneProvider group={chat} passive isFocusedPane>{addTab}</PaneProvider>}
      {tabsVisible && tools && !sharedStrip && (
        <Button size="icon-sm" variant="ghost" title={maximize} aria-label={maximize} onClick={() => layout.setChatToolLayout('full')}>
          <Maximize2 className="size-3.5" />
        </Button>
      )}
      {tools && (tabsVisible || mode === 'hidden') && (
        <Button size="icon-sm" variant="ghost" title={toggleLabel} aria-label={toggleLabel} aria-pressed={tabsVisible}
          className="aria-pressed:bg-row-selected aria-pressed:text-foreground"
          onClick={() => layout.setChatToolLayout(tabsVisible ? 'hidden' : 'split')}>
          <PanelRight className="size-3.5" />
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
  const toolTabs = toolsShown && tools && (
    <div ref={toolColumn} className={divided ? 'absolute inset-y-0 flex' : 'flex min-w-0 flex-1'} data-chat-tool-strip={divided ? '' : undefined}>
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
      {toolCard && mode === 'split' && actionRow}
    </div>
  );
  return (
    <div ref={header} className={sharedStrip ? 'flex min-w-0 shrink-0 bg-tab-strip' : 'relative flex min-w-0 shrink-0'} data-chat-workspace-header={mode}
      data-chat-tool-cards={toolCard ? '' : undefined} data-chat-tool-shared={toolsShown && sharedStrip ? '' : undefined}>
      {/* Clipped (the tools' tabs ride their page in from the edge); the cards' half-pixel rings may show past it. */}
      <div className={cn('flex min-w-0 flex-1', divided && 'relative overflow-clip', toolCard && '[overflow-clip-margin:1px]')}>
        {toolsFirst && toolTabs}
        {chatTitle}
        {!toolsFirst && toolTabs}
      </div>
      {/* The conversation's own head (no tools beside it) is the capsule row: its buttons float at the top right and take
          no width, so the capsule centres on the whole card. Beside tools or merged into one strip they share the row.
          The tools going off (hidden, still on the track) take their strip with them but not these buttons: the toggle is
          on the header from the frame the tools are hidden, ❌ after they land. */}
      {(!toolCard || mode !== 'split') && (full || mode === 'split' ? actionRow : <div className="absolute inset-y-0 right-0 flex">{actionRow}</div>)}
    </div>
  );
});
