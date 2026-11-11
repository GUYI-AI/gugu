import '@/i18n/registerAssistantCatalog';
import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, PanelRight } from '@/lib/icons';
import { useAssistantPanelPage } from '@/lib/assistantPanelPage';
import { appHostLayerSlotKey, readAppHostLayerBridge, type AppHostLayer } from '@/lib/appHostLayerBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { AssistantShellPageFrame } from '@renderer/features/assistant/assistant-ui';
import type { AppHostLayerPage } from '@shared/extensions/app-host-layer';

const noop = () => () => undefined;

/** The title of each host page as the built-in panel heads it (assistant-profile.tsx `ShellPage`). */
const PAGE_TITLES: Record<AppHostLayerPage, string> = { 'assistant-settings': 'nav.settings' };

/**
 * #1925 (API 46) Which host page is drawn over this App's panel now (lib/appHostLayerBridge.ts): a task of the assistant's
 * (`gugu.bindings.openWork`), the assistant's settings (the gear of the host's row); null: the App's page is there.
 */
export function useAppHostLayer(extensionId: string): AppHostLayer['kind'] | null {
  const bridge = readAppHostLayerBridge();
  const kind = () => bridge?.getSnapshot()[extensionId]?.kind ?? null;
  return useSyncExternalStore(bridge?.subscribe ?? noop, kind, kind);
}

/** The cell the shell draws the host page into (AppHostLayerHost). The App's page is set aside meanwhile, never closed. */
function AppHostLayerSlot({ extensionId, className, testId }: { extensionId: string; className: string; testId: string }) {
  const cell = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(appHostLayerSlotKey(extensionId), element), [extensionId]);
  return <div ref={cell} className={className} data-testid={testId} />;
}

/** A task: the built-in panel's task view — the task window with its own back control, the collapse in its corner. */
function HostTaskLayer({ extensionId, onCollapse }: { extensionId: string; onCollapse: (() => void) | null }) {
  const { t } = useTranslation('assistant');
  return (
    <>
      <AppHostLayerSlot extensionId={extensionId} className="ta-task-chat-slot" testId="app-work-chat" />
      {onCollapse ? (
        <button type="button" className="ta-circle ta-task-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={onCollapse} data-testid="app-work-panel-collapse">
          <PanelRight />
        </button>
      ) : null}
    </>
  );
}

/**
 * A page of the host's: as the built-in panel draws it after its gear — its top row (back; collapse), the page's title, the
 * page the shell draws. Back goes up a level the page itself opened (`useAssistantPanelPage`), else closes the page.
 */
function HostPageLayer({ extensionId, kind, onCollapse }: { extensionId: string; kind: AppHostLayerPage; onCollapse: (() => void) | null }) {
  const { t } = useTranslation('assistant');
  const innerPage = useAssistantPanelPage();
  const back = () => (innerPage ? innerPage.back() : readAppHostLayerBridge()?.close(extensionId, kind));
  return (
    <>
      <div className="ta-panel-top">
        <button type="button" className="ta-circle ta-panel-back" aria-label={t('panel.back')} title={t('panel.back')} onClick={back} data-testid="app-host-layer-back">
          <ChevronLeft />
        </button>
        {onCollapse ? (
          <button type="button" className="ta-circle ta-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={onCollapse} data-testid="app-host-layer-collapse">
            <PanelRight />
          </button>
        ) : null}
      </div>
      <div className="ta-panel-body">
        <AssistantShellPageFrame title={t(PAGE_TITLES[kind])} testId={`app-host-layer-${kind}`}>
          <AppHostLayerSlot extensionId={extensionId} className="ta-skin" testId="app-host-layer-cell" />
        </AssistantShellPageFrame>
      </div>
    </>
  );
}

/** The host page over the App's panel, with the host's own controls (`onCollapse`: the panel's collapse; null: none). */
export function AppHostLayerView({ extensionId, kind, onCollapse }: { extensionId: string; kind: AppHostLayer['kind']; onCollapse: (() => void) | null }) {
  return kind === 'work'
    ? <HostTaskLayer extensionId={extensionId} onCollapse={onCollapse} />
    : <HostPageLayer extensionId={extensionId} kind={kind} onCollapse={onCollapse} />;
}

/**
 * The App's page in its own view (`tabId` "dock"), or — while a host page is over it — that page in its place, for a page not
 * placed beside a conversation (`AppConversationFrame` does the same in its panel).
 */
export function AppDockPage({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const layer = useAppHostLayer(extensionId);
  if (!layer) return <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />;
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-ta-scope="">
      <AppHostLayerView extensionId={extensionId} kind={layer} onCollapse={null} />
    </div>
  );
}
