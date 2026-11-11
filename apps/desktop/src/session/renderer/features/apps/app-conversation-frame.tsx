import '@/i18n/registerAssistantCatalog';
import '../assistant/assistant-today.css';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight, Search } from '@/lib/icons';
import { readShellSlots } from '@/lib/shellSlots';
import { appConversationSlotKey, readAppConversationSurfaceBridge } from '@/lib/appConversationSurfaceBridge';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { searchInChat } from '@renderer/features/global-search/search-session';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { setAppConversationPanelCollapsed, useAppConversationPanelCollapsed } from './app-conversation-panel';

/** The App's main page has this tab id here, as on its page of its own (`AppMainPanel`). */
const DOCK = 'dock';

function report(extensionId: string, tabKind: string, shown: { chatId: string; collapsed: boolean } | null): void {
  void rpc.extensions.reportConversationSurface({ extensionId, tabKind, tabId: DOCK, shown }).then((result) => {
    if (!result.success) log.warn('App conversation surface report refused:', result.error);
  }, (error: unknown) => log.warn('App conversation surface report failed:', error));
}

/**
 * #1925 An App's main page that declares `contributes.conversationSurface`: the frame of the built-in assistant page
 * (assistant-view.tsx) — the conversation its binding is bound to as the main column, the page as the collapsible panel on
 * its right, half each. The conversation is the shell's native one, drawn into the column's slot
 * (AppConversationSurfaceHost); only while the shell says it may be drawn (account, installed App, grant, membership) is
 * there a frame at all — otherwise the page opens alone, exactly as an App's page does.
 *
 * Kept from the built-in frame: search and「展开面板」in the column's top row, 「收起面板」in the panel's, the panel's state
 * remembered on this computer. Not kept, being the assistant's own: its name and avatar, its settings gear, its tabs.
 */
export function AppConversationFrame({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const { t } = useTranslation('assistant');
  const bridge = readAppConversationSurfaceBridge();
  const chatId = useSyncExternalStore(
    (listener) => bridge?.subscribe(listener) ?? (() => undefined),
    () => bridge?.getSnapshot()[extensionId] ?? null,
  );
  const collapsed = useAppConversationPanelCollapsed(extensionId);
  // What main tells the App's pages (`gugu.bindings.onSurface`): drawn beside this conversation, the panel as it is; or not.
  useEffect(() => report(extensionId, tabKind, chatId ? { chatId, collapsed } : null), [extensionId, tabKind, chatId, collapsed]);
  useEffect(() => () => report(extensionId, tabKind, null), [extensionId, tabKind]);
  const column = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(appConversationSlotKey(extensionId), element),
    [extensionId],
  );

  if (!chatId) return <ExtensionSharedSlot tabKind={tabKind} tabId={DOCK} />;
  const setCollapsed = (next: boolean) => setAppConversationPanelCollapsed(extensionId, next);
  return (
    <div className="ta-app" data-panel={collapsed ? 'closed' : 'open'} data-testid="app-conversation-surface">
      <div className="ta-chat-col" data-testid="app-conversation-column">
        <div className="ta-chat-top">
          <div className="ta-chat-actions">
            <button type="button" className="ta-circle" aria-label={t('top.search')} title={t('top.search')} onClick={() => searchInChat(chatId)} data-testid="app-conversation-search">
              <Search />
            </button>
            {collapsed ? (
              <button type="button" className="ta-circle" aria-label={t('top.expand')} title={t('top.expand')} onClick={() => setCollapsed(false)} data-testid="app-conversation-panel-expand">
                <PanelRight />
              </button>
            ) : null}
          </div>
        </div>
        <div ref={column} className="ta-chat" data-app-conversation-slot={extensionId} />
      </div>
      {collapsed ? null : (
        <section className="ta-panel" data-testid="app-conversation-panel">
          <div className="ta-panel-top">
            <button type="button" className="ta-circle ta-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={() => setCollapsed(true)} data-testid="app-conversation-panel-collapse">
              <PanelRight />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <ExtensionSharedSlot tabKind={tabKind} tabId={DOCK} />
          </div>
        </section>
      )}
    </div>
  );
}
