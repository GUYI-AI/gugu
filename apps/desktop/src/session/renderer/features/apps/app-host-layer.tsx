// #1925 一层宿主页盖在 App 的面板上,每个 App 同时只开一层(种类见 shared/extensions/app-host-layer.ts,桥见
// lib/appHostLayerBridge.ts —— 一份记录,四种页):
//   · 任务的对话(46,`gugu.bindings.openWork`):壳画内置任务窗进这一格;
//   · 助理的设置(44 `gugu.assistant.open(name, "settings")`,或 46 宿主那一行的齿轮):壳画内置设置页进这一格;
//   · 助理的项目、能力(44 `gugu.assistant.open`):这里画内置面板那一页本身。
// 开着时,App 的页让出位置(页本身在根层常驻,不重建);返回钮、收起钮是宿主自己的。会话页这一侧:谁开(host action、
// 齿轮)、开在哪(App 的页独自一页 = AppHostLayerFrame;摆在会话旁边 = AppConversationFrame 的面板里)、什么时候自己收起
// (那个 App 的页不在了、换了账号、它不再是「找到的助理」)。每开一层、收一层由壳告诉主进程,App 只听到「有宿主页开着 / 关了」。
// 同一处也摆数数的来源(useAssistantAppCounts):内置面板那几行的数,按同一份读法读,只交数字。
import '@/i18n/registerAssistantCatalog';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, PanelRight } from '@/lib/icons';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { useAssistantPanelPage } from '@/lib/assistantPanelPage';
import { appHostLayerSlotKey, readAppHostLayerBridge, type AppHostLayer } from '@/lib/appHostLayerBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { AssistantProjectsLibrary } from '@/components/assistant/AssistantProjectsLibrary';
import { AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { useAssistantMachine } from '@renderer/features/assistant/assistant-data';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { AssistantShellPageFrame } from '@renderer/features/assistant/assistant-ui';
import type { AssistantLayerScreen } from '@shared/extensions/assistant-binding';
import type { AppHostLayerPage } from '@shared/extensions/app-host-layer';
import { AssistantAppCountsSource } from './assistant-app-counts';

const noop = () => () => undefined;

/** The title of the page the shell draws, as the built-in panel heads it (assistant-profile.tsx `ShellPage`). */
const SHELL_PAGE_TITLES: Partial<Record<AppHostLayerPage, string>> = { 'assistant-settings': 'nav.settings' };

/** The whole host page over this App's panel now; null: the App's page is there. */
function useAppHostLayerNow(extensionId: string): AppHostLayer | null {
  const bridge = readAppHostLayerBridge();
  const layer = () => bridge?.getSnapshot()[extensionId] ?? null;
  return useSyncExternalStore(bridge?.subscribe ?? noop, layer, layer);
}

/** A panel page for an account, or an assistant, this window no longer shows: not to be drawn (and closed: `AppHostLayerSources`). */
const pageStale = (layer: AppHostLayer, shell: ReturnType<typeof useAssistantShell>) =>
  layer.kind !== 'work' && (shell?.ownerId !== layer.ownerId || shell.assistantState !== 'found' || !shell.assistant);

/**
 * Which host page is over this App's panel now: a task (`work`) or one of the panel's pages; null: the App's page — also
 * while a panel page waits to be closed for an account or assistant this window no longer shows.
 */
export function useAppHostLayer(extensionId: string): AppHostLayer['kind'] | null {
  const layer = useAppHostLayerNow(extensionId);
  const shell = useAssistantShell();
  return layer && !pageStale(layer, shell) ? layer.kind : null;
}

/** The Apps whose page is on screen now (a frame mounted for each): only there can a page the App asked for be drawn. */
const mounted = new Map<string, number>();

/**
 * Host action `openAssistantScreen` for one of the panel's own pages (44): main checked the account and the binding; this
 * window must still show that account's assistant, and that App's page must be on screen. One layer at a time: it takes the
 * place of what was open (a task's conversation too).
 */
export function openAssistantLayer(extensionId: string, screen: AssistantLayerScreen, ownerId: string): void {
  const shell = readAssistantShellBridge()?.getSnapshot();
  if (!shell || shell.ownerId !== ownerId || shell.assistantState !== 'found' || !shell.assistant) {
    throw new Error('This window does not show that account\'s assistant now');
  }
  if (!mounted.get(extensionId)) throw new Error('This App\'s panel is not on screen');
  const bridge = readAppHostLayerBridge();
  if (!bridge) throw new Error('This window draws no host pages over an App');
  bridge.open(extensionId, { kind: `assistant-${screen}`, ownerId });
}

/** The host's back control, and every reason a page may not stay (account, assistant, the App's page gone). */
export function closeAppHostLayer(extensionId: string): void {
  readAppHostLayerBridge()?.close(extensionId);
}

/** Tests only. */
export function resetMountedAppPagesForTest(): void {
  mounted.clear();
}

/** Whether the App reads the assistant (its binding declares it, and it is on): only then are the panel's numbers read. */
const readsAssistant = (extensionId: string) => installedExtensionsStore.isEnabled(extensionId)
  && installedExtensionsStore.manifests.find((manifest) => manifest.id === extensionId)?.permissions?.bindings?.[0]?.actions.includes('assistant-status') === true;

/**
 * Mounted with the App's main page wherever it stands (alone, or beside its conversation): the page on screen for
 * `openAssistantLayer`, a panel page closed once the App's page goes or this window no longer shows that account's
 * assistant, and the panel's numbers read for an App reading the assistant. A task's conversation is the ledger's
 * (AppHostLayerHost keeps it).
 */
export const AppHostLayerSources = observer(function AppHostLayerSources({ extensionId }: { extensionId: string }) {
  const layer = useAppHostLayerNow(extensionId);
  const shell = useAssistantShell();
  useEffect(() => {
    mounted.set(extensionId, (mounted.get(extensionId) ?? 0) + 1);
    return () => {
      const left = (mounted.get(extensionId) ?? 1) - 1;
      if (left > 0) mounted.set(extensionId, left);
      else {
        mounted.delete(extensionId);
        // A panel page goes with the App's page; a task stays the ledger's (kept while the session page shows and the App
        // reads work, as the built-in task window), back where it was when the App's page is.
        const open = readAppHostLayerBridge()?.getSnapshot()[extensionId];
        if (open && open.kind !== 'work') readAppHostLayerBridge()?.close(extensionId, open.kind);
      }
    };
  }, [extensionId]);
  const stale = !!layer && pageStale(layer, shell);
  useEffect(() => {
    if (stale) closeAppHostLayer(extensionId);
  }, [stale, extensionId]);
  return readsAssistant(extensionId) ? <AssistantAppCountsSource /> : null;
});

/** The cell the shell draws a host page into (AppHostLayerHost). The App's page is set aside meanwhile, never closed. */
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
 * A page of the host's, as the built-in panel draws it: its top row (back; collapse beside a conversation), then the page.
 * Back goes up a level the page itself opened (`useAssistantPanelPage`), else closes the page.
 */
function HostPageLayer({ extensionId, kind, onCollapse }: { extensionId: string; kind: AppHostLayerPage; onCollapse: (() => void) | null }) {
  const { t } = useTranslation('assistant');
  const innerPage = useAssistantPanelPage();
  const title = SHELL_PAGE_TITLES[kind];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ta-scope="" data-testid="app-host-layer" data-layer={kind}>
      <div className="ta-panel-top">
        <button type="button" className="ta-circle ta-panel-back" aria-label={t('panel.back')} title={t('panel.back')}
          onClick={() => (innerPage ? innerPage.back() : readAppHostLayerBridge()?.close(extensionId, kind))} data-testid="app-host-layer-back">
          <ChevronLeft />
        </button>
        {onCollapse ? (
          <button type="button" className="ta-circle ta-panel-collapse" aria-label={t('panel.collapse')} title={t('panel.collapse')} onClick={onCollapse} data-testid="app-host-layer-collapse">
            <PanelRight />
          </button>
        ) : null}
      </div>
      <div className="ta-panel-body">
        {title ? (
          // The settings: the shell's own page (AssistantShellHost's), in this App's own cell.
          <AssistantShellPageFrame title={t(title)} testId={`app-host-layer-${kind}`}>
            <AppHostLayerSlot extensionId={extensionId} className="ta-skin" testId="app-host-layer-cell" />
          </AssistantShellPageFrame>
        ) : <AssistantPanelPage kind={kind} />}
      </div>
    </div>
  );
}

/** The built-in panel's own page for the kinds drawn here, as its 项目 and 能力 rows open them (assistant-profile.tsx). */
function AssistantPanelPage({ kind }: { kind: AppHostLayerPage }) {
  const shell = useAssistantShell();
  const home = shell?.assistant ? shell.home : null;
  const machine = useAssistantMachine(shell?.assistant?.id ?? null, shell?.chatId ?? null, home, shell?.chatReadFailed);
  // As the built-in panel asks in its chat: the draft goes into the assistant's own composer; the App sees none of it.
  const askInChat = (text: string) => readAssistantShellBridge()?.fillChatDraft(text);
  if (kind === 'assistant-projects') return <AssistantProjectsLibrary machine={machine.data} askInChat={askInChat} />;
  return <AssistantLibraryVolume machine={machine.data} assistantId={shell?.assistant?.id ?? ''} kind="capabilities" askInChat={askInChat} />;
}

/** The host page over the App's panel, with the host's own controls (`onCollapse`: the panel's collapse; null: none). */
export function AppHostLayerView({ extensionId, kind, onCollapse }: { extensionId: string; kind: AppHostLayer['kind']; onCollapse: (() => void) | null }) {
  return kind === 'work'
    ? <HostTaskLayer extensionId={extensionId} onCollapse={onCollapse} />
    : <HostPageLayer extensionId={extensionId} kind={kind} onCollapse={onCollapse} />;
}

/**
 * Where an App's main page goes when it stands alone (`tabId` "dock"): its page, or — while a host page is over it — that
 * page in its place (`AppConversationFrame` does the same in its panel). Stands where `<ExtensionSharedSlot tabId="dock">`
 * stood.
 */
export function AppHostLayerFrame({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const layer = useAppHostLayer(extensionId);
  return (
    <>
      <AppHostLayerSources extensionId={extensionId} />
      {layer ? (
        <div className="flex h-full min-h-0 w-full flex-col" data-ta-scope="">
          <AppHostLayerView extensionId={extensionId} kind={layer} onCollapse={null} />
        </div>
      ) : <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />}
    </>
  );
}
