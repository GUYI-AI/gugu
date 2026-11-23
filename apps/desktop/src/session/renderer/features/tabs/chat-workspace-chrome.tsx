import { useDndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, MessageSquare, Minimize2, PanelRight } from '@/lib/icons';
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
  // @@@strip-on-track: divided, the strip's columns are placed on the root cut's first edge as it is drawn. The tools' tabs
  // move as their page beneath does (PanelTrack): at the width they have at rest, on the moving edge, clipped by the strip.
  // The conversation column ends on the edge, its look (narrow or not) that of its width at rest: nothing in the strip
  // changes how it looks mid-move.
  useLayoutEffect(() => {
    const chatNode = chatColumn.current;
    const toolNode = toolColumn.current;
    const place = ({ drawn, from, to, extent }: CutEdge) => {
      if (toolsFirst) {
        const open = Math.max(from, to);
        if (toolNode) Object.assign(toolNode.style, { left: `${drawn - open}px`, width: `${open}px` });
        if (chatNode) chatNode.style.marginInlineStart = `${drawn}px`;
        setChatRest(extent - open);
      } else {
        if (chatNode) chatNode.style.flex = `0 1 ${drawn}px`;
        if (toolNode) Object.assign(toolNode.style, { left: `${drawn}px`, width: `calc(100% - ${Math.min(from, to)}px)` });
        setChatRest(Math.min(from, to));
      }
    };
    if (divided && edge) return edge.attach(place);
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
  const conversationPresentation = layout.chatWorkspaceConversationPresentation;
  const chatActive = layout.activePaneId === chat.paneId;
  const leadingProps = { leadingSlot: leading, reserveShellRestoreLane, leadingReservePx };

  const conversationTab = tab && Title ? <PaneProvider group={chat} passive isFocusedPane={chatActive}>
    <ChatWorkspaceTabContext.Provider value={{ role: 'conversation', layout }}>
      <Title tab={{ ...tab, pairRole: undefined, isActive: sharedStrip ? chatActive : tab.isActive }} host={chat.pane} ctx={chat.pane.ctx} />
    </ChatWorkspaceTabContext.Provider>
  </PaneProvider> : null;
  const chatTitle = !sharedStrip && (
    <div ref={chatColumn} data-chat-workspace-chat-header="" className="min-w-0 flex-1">
      <PaneProvider group={chat} passive isFocusedPane={layout.activePaneId === chat.paneId}>
        <ChatWorkspaceTabContext.Provider value={{ role: toolsShown ? 'conversation' : 'title', layout }}>
          <TabStripShell {...(!toolsFirst ? leadingProps : {})} actionsSlot={actions} restWidth={divided ? chatRest : undefined}>
            {tab && Title ? <Title tab={tab} host={chat.pane} ctx={chat.pane.ctx} /> : null}
          </TabStripShell>
        </ChatWorkspaceTabContext.Provider>
      </PaneProvider>
    </div>
  );
  const toolTabs = toolsShown && tools && (
    <div ref={toolColumn} className={divided ? 'absolute inset-y-0' : 'min-w-0 flex-1'}>
      <PaneProvider group={tools} passive isFocusedPane={!sharedStrip || !chatActive}>
        <ChatWorkspaceTabContext.Provider value={{ role: 'tool', layout }}>
          <TabBar toolsOnly tabTrailingSlot={addTab}
            leadingTabsSlot={sharedStrip && conversationPresentation !== 'bubble' ? conversationTab : undefined}
            selectedTabId={sharedStrip ? chatActive ? tab?.tabId : tools.pane.resolvedActiveTabId : undefined}
            {...(toolsFirst || sharedStrip ? leadingProps : {})} />
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
  const returnToChat = translate('tabs.returnToChat');
  return (
    <div ref={header} className="flex min-w-0 shrink-0 bg-tab-strip" data-chat-workspace-header={mode}>
      <div className={cn('flex min-w-0 flex-1', divided && 'relative overflow-clip')}>
        {toolsFirst && toolTabs}
        {chatTitle}
        {!toolsFirst && toolTabs}
      </div>
      <TabBarActionRow atWindowEdge={!!atWindowEdge}>
        {mode === 'empty' && <PaneProvider group={chat} passive isFocusedPane>{addTab}</PaneProvider>}
        {/* Too narrow for the conversation tab beside the tools: its way back sits in this row, never over the page (an in-app browser page is a native view that would have to step aside under it). */}
        {conversationPresentation === 'bubble' && (
          <Button size="icon-sm" variant="ghost" data-testid="chat-workspace-bubble" title={returnToChat} aria-label={returnToChat}
            onClick={() => layout.showChatWorkspaceConversation()}>
            <MessageSquare className="size-3.5" />
          </Button>
        )}
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
            {/* Narrow enough for the compact way back: icon only, like the tab strip's own exit (index.css), so the page tab keeps its name. */}
            <Minimize2 className="size-3.5" />{conversationPresentation !== 'bubble' && exit}
          </Button>
        )}
      </TabBarActionRow>
    </div>
  );
});
