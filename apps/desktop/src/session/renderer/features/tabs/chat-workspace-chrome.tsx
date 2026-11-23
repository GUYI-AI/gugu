import { useDndContext } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
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
import { CHAT_TOOL_COMPACT_HEADER_MAX_WIDTH_PX } from './chat-tool-geometry';
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

/** The bar the capsule floats in (设计稿 .capbar): 56 high, the card's own white, the capsule centred in it. */
const CAPSULE_BAR_STYLE = { '--tab-strip-height': '56px', '--tab-strip-inset-start': '0px', '--tab-strip-inset-end': '0px', '--tab-strip': 'var(--bg)', '--color-tab-strip': 'var(--bg)' } as CSSProperties;

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
  const chatActive = layout.activePaneId === chat.paneId;
  const divided = mode === 'split' && !!tools && !layout.narrow;
  const toolsFirst = divided && layout.groups[0] === tools;
  const leadingProps = { leadingSlot: leading, reserveShellRestoreLane, leadingReservePx };
  const splitWidth = divided ? `${layout.paneSizes[0]}%` : undefined;
  // Side by side, the conversation and the tools are two cards (index.css); the tools' strip carries its tabs and the view buttons.
  const toolCard = !!layout.chatToolCardPaneId;

  const conversationTab = tab && Title ? <PaneProvider group={chat} passive isFocusedPane={chatActive}>
    <ChatWorkspaceTabContext.Provider value={{ role: 'conversation', layout }}>
      <Title tab={{ ...tab, pairRole: undefined, isActive: sharedStrip ? chatActive : tab.isActive }} host={chat.pane} ctx={chat.pane.ctx} />
    </ChatWorkspaceTabContext.Provider>
  </PaneProvider> : null;
  const chatTitle = !sharedStrip && (
    // 第 16 版 #8:对话自己的那条页签条只剩一颗浮动胶囊(设计稿 .capbar 56 高 / .capsule 居中)。
    <div data-chat-workspace-chat-header="" data-chat-card-head={toolCard ? '' : undefined} className="min-w-0" style={{ ...(toolCard ? { flex: `0 0 calc(${splitWidth} - var(--chat-card-half-gap))` } : { flex: 1 }), ...CAPSULE_BAR_STYLE }}>
      <PaneProvider group={chat} passive isFocusedPane={layout.activePaneId === chat.paneId}>
        <ChatWorkspaceTabContext.Provider value={{ role: 'capsule', layout }}>
          <TabStripShell {...(!toolsFirst ? leadingProps : {})} actionsSlot={actions}>
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
    <div className="flex min-w-0" data-chat-tool-strip={divided ? '' : undefined} style={toolsFirst ? { flex: `0 0 ${splitWidth}` } : { flex: 1 }}>
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
      {toolCard && actionRow}
    </div>
  );
  return (
    <div ref={header} className={sharedStrip ? 'flex min-w-0 shrink-0 bg-tab-strip' : 'flex min-w-0 shrink-0'} data-chat-workspace-header={mode} data-chat-tool-cards={toolCard ? '' : undefined} data-chat-tool-shared={toolsShown && sharedStrip ? '' : undefined}>
      {toolsFirst && toolTabs}
      {chatTitle}
      {!toolsFirst && toolTabs}
      {!toolCard && actionRow}
    </div>
  );
});
