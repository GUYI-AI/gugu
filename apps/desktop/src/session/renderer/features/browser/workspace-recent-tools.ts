import { comparer, reaction } from 'mobx';
import { readViewState, useViewState, writeViewState, type ViewPanel } from '@/lib/viewStateTable';
import { browserAddressKey, BROWSER_DEFAULT_URL } from '@shared/browser';
import type { BrowserState } from './browser-tab-provider';
import type { TabEntry, TabViewContext } from '../tabs/core/tab-provider';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import type { PaneLayoutStore } from '../tabs/pane-layout-store';
import type { PanelItem } from '../chats/chat-tabs/chat-panel-item';
import { isFolderItem, isWaitingItem, WORKSPACE_APP_KIND } from '../chats/chat-tabs/chat-panel-item';
import { fileBaseName } from '../sessions/stores/workspace-path';

export type RecentTool =
  | { kind: 'web'; id: string; title: string; url: string }
  | { kind: 'file'; id: string; title: string; path: string }
  | { kind: 'chat-file'; id: string; title: string; itemId: string }
  | { kind: 'folder'; id: 'folder'; title: string };

type State = { items: RecentTool[] };
const EMPTY: State = { items: [] };
const MAX_RECENT = 12;

export function recentToolPanel(ctx: TabViewContext): ViewPanel {
  const place = ctx.place;
  const conversation = place?.kind === 'chat' ? place.chatId : `task:${place?.kind === 'session' ? place.sessionId : ctx.viewId}`;
  return { conversation, panel: 'recent-tools' };
}

export function recentToolOf(entry: TabEntry, ctx: TabViewContext): RecentTool | undefined {
  if (entry.kind === 'browser') {
    const { session, ephemeral } = entry.state as BrowserState;
    if (ephemeral || !session?.currentUrl || session.currentUrl === BROWSER_DEFAULT_URL || session.isLoading || session.loadError) return;
    return { kind: 'web', id: `web:${browserAddressKey(session.currentUrl)}`, title: session.title || session.currentUrl, url: session.currentUrl };
  }
  if (entry.kind === 'chat-panel') {
    const item = entry.state as PanelItem;
    if (isFolderItem(item)) return { kind: 'folder', id: 'folder', title: item.title };
    if (!item.itemId || isWaitingItem(item)) return;
    return { kind: 'chat-file', id: `chat-file:${item.itemId}`, title: item.fileName ?? item.title, itemId: item.itemId };
  }
  if (ctx.place?.kind !== 'session') return;
  const state = entry.state as { path?: string; filePath?: string };
  const file = entry.kind === 'file-view' ? state.path : state?.filePath;
  if (file) return { kind: 'file', id: `file:${file}`, title: fileBaseName(file), path: file };
  if (entry.kind === WORKSPACE_APP_KIND) {
    return { kind: 'folder', id: 'folder', title: fileBaseName((ctx as SessionTabContext).workspacePath ?? '') };
  }
}

export function trackRecentTools(layout: PaneLayoutStore): () => void {
  const panel = recentToolPanel(layout.mainGroup.pane.ctx);
  return reaction(() => {
    const pane = layout.focusedPane;
    return layout.isViewActive && layout.isPaneShown(layout.activePaneId) && pane.activeEntry
      ? recentToolOf(pane.activeEntry, pane.ctx) : undefined;
  }, (tool) => {
    if (!tool) return;
    const current = readViewState<State>(panel).items ?? [];
    if (comparer.structural(current[0], tool)) return;
    writeViewState<State>(panel, { items: [tool, ...current.filter(({ id }) => id !== tool.id)].slice(0, MAX_RECENT) });
  }, { fireImmediately: true, equals: comparer.structural });
}

export function useRecentTools(panel: ViewPanel) {
  const [recent, write] = useViewState(panel, EMPTY);
  return { items: recent.items, remove: (id: string) => write({ items: recent.items.filter((item) => item.id !== id) }) };
}
