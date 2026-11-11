// #1925 (API 44) 一层宿主页盖在 App 的面板上,每个 App 同时只开一层(形制见 shared/extensions/app-host-layer.ts):
//   · App 经自己的动词要(`gugu.assistant.open(name, "settings" | "projects" | "capabilities")`,主进程验过权),会话页的
//     host action 叫这里 `openAssistantLayer`;壳此刻认的不是那个账号、那个 App 的面板不在 = 抛,不画;
//   · 开着时,App 的页让出位置(页本身在根层常驻,不重建),这里画内置面板那一页本身 + 宿主自己的返回钮;
//     返回、换账号、它不再是「找到的助理」、面板卸下 → 当场收起;
//   · 每开一层、收一层,告诉主进程(`appHostLayerChanged`),App 只听到「有宿主页开着 / 关了」(`hostPage`),❌ 页里的任何内容。
// 同一层面板也摆数数的来源(useAssistantAppCounts):内置面板那几行的数,按同一份读法读,只交数字。
// 以后别的宿主页(如任务对话)= 再加一种 kind,同一个格子、同一个返回钮。
// 同一格还画 App 要的那只会动的小鸟(`gugu.assistant.figure`):形象是引擎一帧帧画的(AgentAvatar),交不出一张图,
// 于是宿主把它画在 App 页上 App 说的那个位置,裁在页里、点击穿透;App 页里排版变了自己再说一次。
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AgentAvatar } from '@/components/agentAvatar/AgentAvatar';
import { DEFAULT_ASSISTANT_LOOK } from '@/components/agentAvatar/look';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from '@/lib/icons';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { useAssistantPanelPage } from '@/lib/assistantPanelPage';
import { AssistantProjectsLibrary } from '@/components/assistant/AssistantProjectsLibrary';
import { AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { useAssistantMachine } from '@renderer/features/assistant/assistant-data';
import { ShellPage } from '@renderer/features/assistant/assistant-profile';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import type { AssistantFigure, AssistantLayerScreen } from '@shared/extensions/assistant-binding';
import type { AppHostLayer } from '@shared/extensions/app-host-layer';
import { AssistantAppCountsSource } from './assistant-app-counts';

type Layers = Readonly<Record<string, AppHostLayer>>;

const NONE: Layers = Object.freeze({});
let current: Layers = NONE;
const listeners = new Set<() => void>();
/** The Apps whose panel is on screen now (a frame mounted for each): only there can a layer be drawn. */
const mounted = new Map<string, number>();
/** Which page asked for each open layer (`pageKey`): its new document — a reload, a withdrawn grant — closes it. */
const openers = new Map<string, string>();
/** A page as the window's host actions name it. */
export const pageKey = (sessionId: string | null, tabId: string) => `${sessionId ?? ''}\u0000${tabId}`;

function report(extensionId: string, layer: AppHostLayer | null): void {
  void rpc.extensions.appHostLayerChanged({ extensionId, layer }).then((result) => {
    if (!result.success) log.warn('App host layer report refused', { extensionId, error: result.error });
  }, (error: unknown) => log.warn('App host layer report failed', { extensionId, error: String(error) }));
}

function publish(extensionId: string, layer: AppHostLayer | null): void {
  const before = current[extensionId] ?? null;
  if (before?.kind === layer?.kind && before?.ownerId === layer?.ownerId) return;
  const { [extensionId]: _was, ...rest } = current;
  const next = layer ? { ...rest, [extensionId]: layer } : rest;
  current = Object.keys(next).length === 0 ? NONE : Object.freeze(next);
  for (const listener of [...listeners]) listener();
  report(extensionId, layer);
}

/**
 * Host action `openAssistantScreen` for one of the panel's own pages: main checked the account and the binding; this
 * window must still show that account's assistant, and that App's panel must be on screen. One layer at a time: a second
 * one takes the first one's place.
 */
export function openAssistantLayer(extensionId: string, screen: AssistantLayerScreen, ownerId: string, from: string): void {
  const shell = readAssistantShellBridge()?.getSnapshot();
  if (!shell || shell.ownerId !== ownerId || shell.assistantState !== 'found' || !shell.assistant) {
    throw new Error('This window does not show that account\'s assistant now');
  }
  if (!mounted.get(extensionId)) throw new Error('This App\'s panel is not on screen');
  openers.set(extensionId, from);
  publish(extensionId, { kind: `assistant-${screen}`, ownerId });
}

/** The host's back control, and every reason it may not stay (account, assistant, the panel gone). */
export function closeAppHostLayer(extensionId: string): void {
  openers.delete(extensionId);
  if (current[extensionId]) publish(extensionId, null);
}

export function useAppHostLayer(extensionId: string): AppHostLayer | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current[extensionId] ?? null,
  );
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
 * makes): what that page asked for over the panel — a layer, the figure — goes with the document that asked.
 */
export function appPageNewDocument(extensionId: string, from: string): void {
  if (openers.get(extensionId) === from) closeAppHostLayer(extensionId);
  if (figures[extensionId]?.from === from) publishFigure(extensionId, null);
}

/** Tests only. */
export function resetAppHostLayersForTest(): void {
  current = NONE;
  figures = Object.freeze({});
  mounted.clear();
  openers.clear();
}

/** Whether the App reads the assistant (its binding declares it, and it is on): only then are the panel's numbers read. */
const readsAssistant = (extensionId: string) => installedExtensionsStore.isEnabled(extensionId)
  && installedExtensionsStore.manifests.find((manifest) => manifest.id === extensionId)?.permissions?.bindings?.[0]?.actions.includes('assistant-status') === true;

/**
 * Where an App's main page goes: its page, or — while a host layer is open over it — the host's page with a back control
 * of the host's. Stands where `<ExtensionSharedSlot tabId="dock">` stood.
 */
export const AppHostLayerFrame = observer(function AppHostLayerFrame({ extensionId, tabKind }: { extensionId: string; tabKind: string }) {
  const layer = useAppHostLayer(extensionId);
  const shell = useAssistantShell();
  useEffect(() => {
    mounted.set(extensionId, (mounted.get(extensionId) ?? 0) + 1);
    return () => {
      const left = (mounted.get(extensionId) ?? 1) - 1;
      if (left > 0) mounted.set(extensionId, left);
      else {
        mounted.delete(extensionId);
        closeAppHostLayer(extensionId);
        setAssistantFigure(extensionId, null);
      }
    };
  }, [extensionId]);
  const stale = !!layer && (shell?.ownerId !== layer.ownerId || shell.assistantState !== 'found' || !shell.assistant);
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
  const anchor = useRef<HTMLDivElement>(null);
  if (layer && !stale) {
    return (
      <>
        {readsAssistant(extensionId) ? <AssistantAppCountsSource /> : null}
        <AppHostLayerPage extensionId={extensionId} layer={layer} />
      </>
    );
  }
  return (
    <>
      {readsAssistant(extensionId) ? <AssistantAppCountsSource /> : null}
      <div ref={anchor} className="flex min-h-0 flex-1 flex-col" data-testid="app-page-anchor">
        <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />
      </div>
      {figure && !figureStale ? <AssistantFigureOverlay anchor={anchor} figure={figure} /> : null}
    </>
  );
});

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

function AppHostLayerPage({ extensionId, layer }: { extensionId: string; layer: AppHostLayer }) {
  const { t } = useTranslation('assistant');
  const innerPage = useAssistantPanelPage();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ta-scope data-testid="app-host-layer" data-layer={layer.kind}>
      <div className="ta-panel-top">
        {/* The host's own back: a page inside it first (as the built-in panel's back), then the layer itself. */}
        <button type="button" className="ta-circle ta-panel-back" aria-label={t('panel.back')} title={t('panel.back')}
          onClick={() => (innerPage ? innerPage.back() : closeAppHostLayer(extensionId))} data-testid="app-host-layer-back">
          <ChevronLeft />
        </button>
      </div>
      <div className="ta-panel-body">
        <AssistantLayerBody kind={layer.kind} />
      </div>
    </div>
  );
}

/** The built-in panel's own page for each kind, as its gear, 项目 and 能力 rows open them (assistant-profile.tsx). */
function AssistantLayerBody({ kind }: { kind: AppHostLayer['kind'] }) {
  const shell = useAssistantShell();
  const home = shell?.assistant ? shell.home : null;
  const machine = useAssistantMachine(shell?.assistant?.id ?? null, shell?.chatId ?? null, home, shell?.chatReadFailed);
  // As the built-in panel asks in its chat: the draft goes into the assistant's own composer; the App sees none of it.
  const askInChat = (text: string) => readAssistantShellBridge()?.fillChatDraft(text);
  if (kind === 'assistant-settings') return <ShellPage slot="settings" title="nav.settings" />;
  if (kind === 'assistant-projects') return <AssistantProjectsLibrary machine={machine.data} askInChat={askInChat} />;
  return <AssistantLibraryVolume machine={machine.data} assistantId={shell?.assistant?.id ?? ''} kind="capabilities" askInChat={askInChat} />;
}
