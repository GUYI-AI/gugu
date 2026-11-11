import '@/i18n/registerAssistantCatalog';
import '../assistant/assistant-today.css';
import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight, Search } from '@/lib/icons';
import { readShellSlots } from '@/lib/shellSlots';
import { appConversationSlotKey, readAppConversationSurfaceBridge } from '@/lib/appConversationSurfaceBridge';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { searchInChat } from '@renderer/features/global-search/search-session';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { CONVERSATION_SURFACE_PANEL_INSET } from '@shared/extensions/unread-binding';
import { setAppConversationPanelCollapsed, useAppConversationPanelCollapsed } from './app-conversation-panel';
import { AppDockPage, AppWorkChatSlot, useAppWorkChatOpen } from './app-work-slot';

/** The App's main page has this tab id here, as on its page of its own (`AppMainPanel`). */
const DOCK = 'dock';
/**
 * The corner the collapse control sits in, over the App's page: the very box `panel.inset` tells the App, so what it is told
 * is what is covered at every width. The control is centred in its height and 16px in from the right, as on the built-in
 * panel's top row. Above the page (a resident page is drawn in the root layer), clicks outside the control reach the page.
 */
const CORNER: CSSProperties = {
  position: 'absolute', top: 0, right: 0, width: CONVERSATION_SURFACE_PANEL_INSET.right, height: CONVERSATION_SURFACE_PANEL_INSET.top,
  display: 'flex', alignItems: 'center', justifyContent: 'flex-start', zIndex: 'var(--z-pane-resident-chrome)', pointerEvents: 'none',
};

/** #1927 (48) The host's recording bar, loaded only when an App's column is drawn (the assistant chat's, it then decides). */
const AppConversationVoiceBar = lazy(() => import('./app-conversation-voice-bar'));

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
 * Kept from the built-in frame: search and「展开面板」in the column's top row, 「收起面板」over the top-right corner of the
 * panel as on the built-in's top row, the panel's state remembered on this computer. The App's page fills the panel, so a
 * page drawing its own top row (name, tabs) lines up with the built-in's; `panel.inset` tells it which corner to keep clear.
 * Not kept, being the assistant's own: its name and avatar, its settings gear, its tabs.
 */
export function AppConversationFrame({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const { t } = useTranslation('assistant');
  const bridge = readAppConversationSurfaceBridge();
  const chatId = useSyncExternalStore(
    (listener) => bridge?.subscribe(listener) ?? (() => undefined),
    () => bridge?.getSnapshot()[extensionId] ?? null,
  );
  const collapsed = useAppConversationPanelCollapsed(extensionId);
  // #1925 (46) One of the assistant's tasks open in this panel: the built-in panel's task view, the page set aside.
  const workOpen = useAppWorkChatOpen(extensionId);
  // What main tells the App's pages (`gugu.bindings.onSurface`): drawn beside this conversation, the panel as it is; or not.
  useEffect(() => report(extensionId, tabKind, chatId ? { chatId, collapsed } : null), [extensionId, tabKind, chatId, collapsed]);
  useEffect(() => () => report(extensionId, tabKind, null), [extensionId, tabKind]);
  const column = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(appConversationSlotKey(extensionId), element),
    [extensionId],
  );
  // The column the recording bar sits in, above its composer (as the built-in's `chatColumn`).
  const [chatColumn, setChatColumn] = useState<HTMLDivElement | null>(null);

  if (!chatId) return <AppDockPage extensionId={extensionId} tabKind={tabKind} />;
  const setCollapsed = (next: boolean) => setAppConversationPanelCollapsed(extensionId, next);
  return (
    <div className="ta-app" data-panel={collapsed ? 'closed' : 'open'} data-testid="app-conversation-surface">
      <div ref={setChatColumn} className="ta-chat-col" data-testid="app-conversation-column">
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
        <Suspense fallback={null}><AppConversationVoiceBar extensionId={extensionId} chatId={chatId} column={chatColumn} /></Suspense>
      </div>
      {collapsed ? null : (
        <section className="ta-panel" data-testid="app-conversation-panel">
          {workOpen ? (
            <>
              <AppWorkChatSlot extensionId={extensionId} />
              <button type="button" className="ta-circle ta-task-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={() => setCollapsed(true)} data-testid="app-work-panel-collapse">
                <PanelRight />
              </button>
            </>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 flex-col">
                <ExtensionSharedSlot tabKind={tabKind} tabId={DOCK} />
              </div>
              <div style={CORNER} data-testid="app-conversation-panel-corner">
                <button type="button" className="ta-circle ta-panel-collapse" style={{ pointerEvents: 'auto' }} aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={() => setCollapsed(true)} data-testid="app-conversation-panel-collapse">
                  <PanelRight />
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
