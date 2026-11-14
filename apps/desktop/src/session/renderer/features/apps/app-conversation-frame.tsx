import '@/i18n/registerAssistantCatalog';
import '../assistant/assistant-today.css';
import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight } from '@/lib/icons';
import { readShellSlots } from '@/lib/shellSlots';
import { appConversationSlotKey, readAppConversationSurfaceBridge } from '@/lib/appConversationSurfaceBridge';
import { readAppHostLayerBridge } from '@/lib/appHostLayerBridge';
import type { AssistantShellSnapshot } from '@/lib/assistantShellBridge';
import { AssistantChatTop, type AssistantChatTopIdentity } from '@renderer/features/assistant/assistant-chat-top';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { ShellTitlebarDragRegion } from '@renderer/lib/components/titlebar/shell-titlebar';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { CONVERSATION_SURFACE_PANEL_INSET } from '@shared/extensions/unread-binding';
import { setAppConversationPanelCollapsed, useAppConversationPanelCollapsed } from './app-conversation-panel';
import { AppHostLayerFrame, AppHostLayerSources, AppHostLayerView, AppPagePlace, useAppHostLayer } from './app-host-layer';

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
const noop = () => () => undefined;

/** #1927 (48) The host's recording bar, loaded only when an App's column is drawn (the assistant chat's, it then decides). */
const AppConversationVoiceBar = lazy(() => import('./app-conversation-voice-bar'));

function report(extensionId: string, tabKind: string, shown: { chatId: string; collapsed: boolean } | null, intent?: 'profile'): void {
  void rpc.extensions.reportConversationSurface({ extensionId, tabKind, tabId: DOCK, shown, ...(intent ? { intent } : {}) }).then((result) => {
    if (!result.success) log.warn('App conversation surface report refused:', result.error);
  }, (error: unknown) => log.warn('App conversation surface report failed:', error));
}

/**
 * #1925 (46) The middle of the host's row, as the built-in assistant page shows it: the assistant (face and name), only when
 * the shell's own assistant is this account's and this is its chat; else the state the built-in page says it is in. Another
 * assistant's chat in the shell's eyes: nothing there.
 */
function headerIdentity(shell: AssistantShellSnapshot | null, ownerId: string, chatId: string, onOpen: () => void): AssistantChatTopIdentity | null {
  if (!shell || shell.ownerId !== ownerId) return { kind: 'state', state: 'loading' };
  if (shell.assistant) {
    if (shell.chatId === chatId) return { kind: 'assistant', assistant: shell.assistant, onOpen };
    return shell.chatId === null ? { kind: 'state', state: 'loading' } : null;
  }
  if (shell.preparing) return { kind: 'state', state: 'preparing' };
  return { kind: 'state', state: shell.assistantState === 'found' ? 'loading' : shell.assistantState };
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
 * 46, `conversationSurface.header: "assistant"`, over the account's own assistant chat (the shell's word, main-verified):
 * the built-in row itself (AssistantChatTop) — its face and name (a click: the App hears `intent: profile`, the panel
 * expanded, any host page closed), its settings gear (the host's settings page over the panel). A host page over the panel
 * (app-host-layer.tsx) sets the App's page aside until it closes.
 */
export function AppConversationFrame({ extensionId, tabKind, windowHandle = false }: {
  extensionId: string;
  tabKind: string;
  /**
   * The page starts at the window's top (the assistant's page, apps-views.tsx): the window's handle is the column's top band,
   * never a band across the panel — the App's page there is a webview, and no host drag region may lie over it.
   */
  windowHandle?: boolean;
}) {
  const { t } = useTranslation('assistant');
  const bridge = readAppConversationSurfaceBridge();
  const chatId = useSyncExternalStore(
    (listener) => bridge?.subscribe(listener) ?? (() => undefined),
    () => bridge?.getSnapshot()[extensionId] ?? null,
  );
  const header = useSyncExternalStore(bridge?.subscribe ?? noop, () => bridge?.getHeaders()[extensionId] ?? null);
  const shell = useAssistantShell();
  const collapsed = useAppConversationPanelCollapsed(extensionId);
  // #1925 (46) A host page over this panel (a task, the assistant's settings): the built-in panel's views, the page set aside.
  const layer = useAppHostLayer(extensionId);
  // What main tells the App's pages (`gugu.bindings.onSurface`): drawn beside this conversation, the panel as it is; or not.
  useEffect(() => report(extensionId, tabKind, chatId ? { chatId, collapsed } : null), [extensionId, tabKind, chatId, collapsed]);
  useEffect(() => () => report(extensionId, tabKind, null), [extensionId, tabKind]);
  const column = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(appConversationSlotKey(extensionId), element),
    [extensionId],
  );
  // The column the recording bar sits in, above its composer (as the built-in's `chatColumn`).
  const [chatColumn, setChatColumn] = useState<HTMLDivElement | null>(null);

  if (!chatId) return <AppHostLayerFrame extensionId={extensionId} tabKind={tabKind} />;
  const setCollapsed = (next: boolean) => setAppConversationPanelCollapsed(extensionId, next);
  // The face and name: the App's page shows the profile — told once, with the panel expanded and nothing over it.
  const showProfile = () => {
    readAppHostLayerBridge()?.close(extensionId);
    setCollapsed(false);
    report(extensionId, tabKind, { chatId, collapsed: false }, 'profile');
  };
  const identity = header ? headerIdentity(shell, header.ownerId, chatId, showProfile) : null;
  // The gear: the assistant's settings, the host's own page, over the panel (in place of any task open there).
  const openSettings = header && identity?.kind === 'assistant' ? () => {
    setCollapsed(false);
    try {
      readAppHostLayerBridge()?.open(extensionId, { kind: 'assistant-settings', ownerId: header.ownerId });
    } catch (error) {
      log.warn('The assistant\'s settings could not be opened over the App:', error);
    }
  } : null;
  return (
    <div className="ta-app" data-panel={collapsed ? 'closed' : 'open'} data-testid="app-conversation-surface">
      <AppHostLayerSources extensionId={extensionId} />
      <div ref={setChatColumn} className="ta-chat-col" data-testid="app-conversation-column">
        {/* First in the column: the row's buttons after it take their no-drag out of it. */}
        {windowHandle ? <ShellTitlebarDragRegion /> : null}
        <AssistantChatTop testIdPrefix="app-conversation" identity={identity} chatId={chatId} onSettings={openSettings} panelOpen={!collapsed} onExpand={() => setCollapsed(false)} />
        <div ref={column} className="ta-chat" data-app-conversation-slot={extensionId} />
        <Suspense fallback={null}><AppConversationVoiceBar extensionId={extensionId} chatId={chatId} column={chatColumn} /></Suspense>
      </div>
      {collapsed ? null : (
        <section className="ta-panel" data-testid="app-conversation-panel">
          {layer ? <AppHostLayerView extensionId={extensionId} kind={layer} onCollapse={() => setCollapsed(true)} /> : (
            <>
              <AppPagePlace extensionId={extensionId} tabKind={tabKind} />
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
