// #1925 一层宿主页盖在 App 的面板上,每个 App 同时只开一层(种类见 shared/extensions/app-host-layer.ts,桥见
// lib/appHostLayerBridge.ts —— 一份记录,四种页):
//   · 任务的对话(46,`gugu.bindings.openWork`):壳画内置任务窗进这一格;
//   · 助理的设置(44 `gugu.assistant.open(name, "settings")`,或 46 宿主那一行的齿轮):壳画内置设置页进这一格;
//   · 助理的项目、能力(44 `gugu.assistant.open`):这里画内置面板那一页本身。
// 开着时,App 的页让出位置(页本身在根层常驻,不重建);返回钮、收起钮是宿主自己的。会话页这一侧:谁开(host action、
// 齿轮)、开在哪(App 的页独自一页 = AppHostLayerFrame;摆在会话旁边 = AppConversationFrame 的面板里)、什么时候自己收起
// (那个 App 的页不在了、换了账号、它不再是「找到的助理」)。每开一层、收一层由壳告诉主进程,App 只听到「有宿主页开着 / 关了」。
// 同一处也摆数数的来源(useAssistantAppCounts):内置面板那几行的数,按同一份读法读,只交数字。
// 同一处还画 App 要的那只会动的小鸟(44 `gugu.assistant.figure`):形象是引擎一帧帧画的(AgentAvatar),交不出一张图,
// 于是宿主把它画在 App 页上 App 说的那个位置,裁在页里、点击穿透;宿主页盖着时不画。App 的页换了文档(重载、改了授权)=
// 它要过的宿主页和小鸟一并收起。
import '@/i18n/registerAssistantCatalog';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AgentAvatar } from '@/components/agentAvatar/AgentAvatar';
import { DEFAULT_ASSISTANT_LOOK } from '@/components/agentAvatar/look';
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
import type { AssistantFigure, AssistantLayerScreen } from '@shared/extensions/assistant-binding';
import { assistantLayerPage, assistantLayerPageShown, type AppHostLayerPage } from '@shared/extensions/app-host-layer';
import { AssistantAppCountsSource } from './assistant-app-counts';

const noop = () => () => undefined;

/**
 * The pages the shell draws into this App's cell (AppHostLayerHost), with the title the built-in panel heads them with
 * (assistant-profile.tsx `ShellPage`); null: the page heads itself (the setup guide's own card).
 */
const SHELL_PAGE_TITLES: Partial<Record<AppHostLayerPage, string | null>> = {
  'assistant-setup': null,
  'assistant-settings': 'nav.settings',
  'assistant-connected-apps': 'connectors.title',
};

/** The whole host page over this App's panel now; null: the App's page is there. */
function useAppHostLayerNow(extensionId: string): AppHostLayer | null {
  const bridge = readAppHostLayerBridge();
  const layer = () => bridge?.getSnapshot()[extensionId] ?? null;
  return useSyncExternalStore(bridge?.subscribe ?? noop, layer, layer);
}

/**
 * A panel page for an account this window no longer shows, or for the assistant as it no longer is (the setup guide once
 * the assistant is there: the App draws the steps after it; any other page once it is gone): not to be drawn (and closed:
 * `AppHostLayerSources`).
 */
const pageStale = (layer: AppHostLayer, shell: ReturnType<typeof useAssistantShell>) =>
  layer.kind !== 'work' && (shell?.ownerId !== layer.ownerId || !assistantLayerPageShown(layer.kind, shell.assistantState === 'found' && !!shell.assistant));

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
/** Which page asked for each open panel page (`pageKey`), and which: its new document — a reload, a withdrawn grant — closes it. */
const openers = new Map<string, { from: string; kind: AppHostLayer['kind'] }>();
/** A page as the window's host actions name it. */
export const pageKey = (sessionId: string | null, tabId: string) => `${sessionId ?? ''}\u0000${tabId}`;

/**
 * Host action `openAssistantScreen` for one of the assistant's own pages (44): main checked the account and the binding; this
 * window must still show that account (with its assistant, for every page but the setup guide), and that App's page must be
 * on screen. One layer at a time: it takes the place of what was open (a task's conversation too). The setup guide starts
 * at the name (AssistantSetupPage): the App's own intro, under it, is its first screen.
 */
export function openAssistantLayer(extensionId: string, screen: AssistantLayerScreen, ownerId: string, from: string): void {
  const shell = readAssistantShellBridge()?.getSnapshot();
  if (!shell || shell.ownerId !== ownerId) throw new Error('This window does not show that account now');
  const kind = assistantLayerPage(screen, shell.assistantState === 'found' && !!shell.assistant);
  if (kind !== 'assistant-setup' && (shell.assistantState !== 'found' || !shell.assistant)) {
    throw new Error('This window does not show that account\'s assistant now');
  }
  if (!mounted.get(extensionId)) throw new Error('This App\'s panel is not on screen');
  const bridge = readAppHostLayerBridge();
  if (!bridge) throw new Error('This window draws no host pages over an App');
  bridge.open(extensionId, { kind, ownerId });
  openers.set(extensionId, { from, kind });
}

/** The host's back control, and every reason a page may not stay (account, assistant, the App's page gone). */
export function closeAppHostLayer(extensionId: string): void {
  readAppHostLayerBridge()?.close(extensionId);
}

/** The figure each App asked for over its page: where, for which account, and whose (the assistant, or the setup bird). */
type Figure = { figure: AssistantFigure; ownerId: string; who: 'assistant' | 'draft'; from: string };
let figures: Readonly<Record<string, Figure>> = Object.freeze({});
const figureListeners = new Set<() => void>();
function publishFigure(extensionId: string, next: Figure | null): void {
  const { [extensionId]: _was, ...rest } = figures;
  figures = Object.freeze(next ? { ...rest, [extensionId]: next } : rest);
  for (const listener of [...figureListeners]) listener();
}

/**
 * Host action `assistantFigure`: main checked the account and what `status` shows; this window must still show the same
 * (that account, and the assistant found — or not, for the setup bird), and that App's panel must be on screen. null
 * takes it away.
 */
export function setAssistantFigure(extensionId: string, next: Figure | null): void {
  if (!next) {
    if (figures[extensionId]) publishFigure(extensionId, null);
    return;
  }
  const shell = readAssistantShellBridge()?.getSnapshot();
  const found = shell?.assistantState === 'found' && !!shell.assistant;
  if (!shell || shell.ownerId !== next.ownerId || found !== (next.who === 'assistant')) throw new Error('This window does not show that now');
  if (!mounted.get(extensionId)) throw new Error('This App\'s panel is not on screen');
  publishFigure(extensionId, next);
}

function useAssistantFigure(extensionId: string): Figure | null {
  return useSyncExternalStore(
    (listener) => {
      figureListeners.add(listener);
      return () => {
        figureListeners.delete(listener);
      };
    },
    () => figures[extensionId] ?? null,
  );
}

/**
 * A page of the App started a new document (host action `newDocument`: a reload, a navigation, the reload a changed grant
 * makes): what that page asked for over the panel — a panel page still open, the figure — goes with the document that asked.
 */
export function appPageNewDocument(extensionId: string, from: string): void {
  const opener = openers.get(extensionId);
  if (opener?.from === from) {
    openers.delete(extensionId);
    if (readAppHostLayerBridge()?.getSnapshot()[extensionId]?.kind === opener.kind) readAppHostLayerBridge()?.close(extensionId, opener.kind);
  }
  if (figures[extensionId]?.from === from) publishFigure(extensionId, null);
}


/** Tests only. */
export function resetMountedAppPagesForTest(): void {
  mounted.clear();
  openers.clear();
  figures = Object.freeze({});
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
        setAssistantFigure(extensionId, null);
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
  const figure = useAssistantFigure(extensionId);
  const found = shell?.assistantState === 'found' && !!shell.assistant;
  // The figure goes with what main checked: another account, or the assistant found or gone since, takes it away.
  const figureStale = !!figure && (shell?.ownerId !== figure.ownerId || found !== (figure.who === 'assistant'));
  useEffect(() => {
    if (figureStale) setAssistantFigure(extensionId, null);
  }, [figureStale, extensionId]);
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
          // The settings, the connected apps: the shell's own page (AppHostLayerHost's), in this App's own cell.
          <AssistantShellPageFrame title={t(title)} testId={`app-host-layer-${kind}`}>
            <AppHostLayerSlot extensionId={extensionId} className="ta-skin" testId="app-host-layer-cell" />
          </AssistantShellPageFrame>
        ) : title === null ? (
          // The setup guide: its own card, centred where the App's intro was.
          <div className="flex min-h-full flex-col items-center justify-center" data-testid={`app-host-layer-${kind}`}>
            <AppHostLayerSlot extensionId={extensionId} className="ta-skin flex w-full justify-center" testId="app-host-layer-cell" />
          </div>
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
 * The figure over the page, where the App said, clipped to the page and above it (the page is drawn in the root layer at
 * `--z-pane-resident`); clicks go through to the page. It follows the page's box as the host lays it out.
 */
function AssistantFigureOverlay({ anchor, figure }: { anchor: RefObject<HTMLDivElement | null>; figure: Figure }) {
  const { t } = useTranslation('assistant');
  const shell = useAssistantShell();
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox((last) => (last && last.left === rect.left && last.top === rect.top && last.width === rect.width && last.height === rect.height
        ? last : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor]);
  const assistant = shell?.assistant;
  if (!box || (figure.who === 'assistant' && !assistant)) return null;
  const { x, y, size } = figure.figure;
  return createPortal(
    <div aria-hidden data-testid="app-assistant-figure" data-who={figure.who}
      style={{ position: 'fixed', ...box, overflow: 'hidden', pointerEvents: 'none', zIndex: 'calc(var(--z-pane-resident) + 1)' }}>
      <div style={{ position: 'absolute', left: x, top: y, width: size, height: size }}>
        {figure.who === 'assistant' && assistant
          ? <AgentAvatar id={assistant.id} avatar={assistant.avatar} name={assistant.display_name} size={size} />
          : <AgentAvatar id="assistant-draft" name={t('rail')} look={DEFAULT_ASSISTANT_LOOK} size={size} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The App's page itself (`tabId` "dock") where a host page is not over it, with the assistant's figure the App asked for
 * drawn over it (`gugu.assistant.figure`). Alone or beside its conversation.
 */
export function AppPagePlace({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const figure = useAssistantFigure(extensionId);
  const shell = useAssistantShell();
  const found = shell?.assistantState === 'found' && !!shell.assistant;
  const shown = !!figure && shell?.ownerId === figure.ownerId && found === (figure.who === 'assistant');
  return (
    <>
      <div ref={anchor} className="flex min-h-0 flex-1 flex-col" data-testid="app-page-anchor" data-app-page-anchor="">
        <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />
      </div>
      {shown ? <AssistantFigureOverlay anchor={anchor} figure={figure} /> : null}
    </>
  );
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
      ) : <AppPagePlace extensionId={extensionId} tabKind={tabKind} />}
    </>
  );
}
