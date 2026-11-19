import { useDndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type ReactNode } from 'react';
import { Maximize2, Minimize2, PanelRight } from '@/lib/icons';
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
import { TabBar, TabStripShell } from './tab-bar';
import { ChatWorkspaceTabContext } from './chat-workspace-context';

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
  layout, actions, addTab, leading, reserveShellRestoreLane, leadingReservePx, atWindowEdge, embedded = false,
}: ChatWorkspaceChromeProps & { layout: PaneLayoutStore }) {
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
  if (!panes || !mode) return null;
  const { chat, tools } = panes;
  const tab = chat.pane.resolvedTabs.find(({ tabId }) => tabId === layout.primaryChatTabId);
  const Title = tab && chat.pane.registry.has(tab.kind) ? chat.pane.registry.get(tab.kind).TabBarItem : null;
  const full = mode === 'full';
  const toolsShown = full || mode === 'split';
  const sharedStrip = full || mode === 'split' && layout.narrow;
  const conversationPresentation = layout.chatWorkspaceConversationPresentation;
  const chatActive = layout.activePaneId === chat.paneId;
  const divided = mode === 'split' && !!tools && !layout.narrow;
  const toolsFirst = divided && layout.groups[0] === tools;
  const leadingProps = { leadingSlot: leading, reserveShellRestoreLane, leadingReservePx };
  const splitWidth = divided ? `${layout.paneSizes[0]}%` : undefined;

  const conversationTab = tab && Title ? <PaneProvider group={chat} passive isFocusedPane={chatActive}>
    <ChatWorkspaceTabContext.Provider value={{ role: 'conversation', layout }}>
      <Title tab={{ ...tab, pairRole: undefined, isActive: sharedStrip ? chatActive : tab.isActive }} host={chat.pane} ctx={chat.pane.ctx} />
    </ChatWorkspaceTabContext.Provider>
  </PaneProvider> : null;
  const chatTitle = !sharedStrip && (
    <div data-chat-workspace-chat-header="" className="min-w-0" style={divided && !toolsFirst ? { flex: `0 0 ${splitWidth}` } : { flex: 1 }}>
      <PaneProvider group={chat} passive isFocusedPane={layout.activePaneId === chat.paneId}>
        <ChatWorkspaceTabContext.Provider value={{ role: toolsShown ? 'conversation' : 'title', layout }}>
          <TabStripShell {...(!toolsFirst ? leadingProps : {})} actionsSlot={actions}>
            {tab && Title ? <Title tab={tab} host={chat.pane} ctx={chat.pane.ctx} /> : null}
          </TabStripShell>
        </ChatWorkspaceTabContext.Provider>
      </PaneProvider>
    </div>
  );
  const toolTabs = toolsShown && tools && (
    <div className="min-w-0" style={toolsFirst ? { flex: `0 0 ${splitWidth}` } : { flex: 1 }}>
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
  return (
    <div ref={header} className="flex min-w-0 shrink-0 bg-tab-strip" data-chat-workspace-header={mode}>
      {toolsFirst && toolTabs}
      {chatTitle}
      {!toolsFirst && toolTabs}
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
          <Button size="sm" variant="ghost" className="gap-1 text-xs" title={exit} onClick={() => layout.setChatToolLayout('split')}>
            <Minimize2 className="size-3.5" />{exit}
          </Button>
        )}
      </TabBarActionRow>
    </div>
  );
});
