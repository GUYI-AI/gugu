// #1925 (API 44) 一层宿主页盖在 App 的面板上,每个 App 同时只开一层(形制见 shared/extensions/app-host-layer.ts):
//   · App 经自己的动词要(`gugu.assistant.open(name, "settings" | "projects" | "capabilities")`,主进程验过权),会话页的
//     host action 叫这里 `openAssistantLayer`;壳此刻认的不是那个账号、那个 App 的面板不在 = 抛,不画;
//   · 开着时,App 的页让出位置(页本身在根层常驻,不重建),这里画内置面板那一页本身 + 宿主自己的返回钮;
//     返回、换账号、它不再是「找到的助理」、面板卸下 → 当场收起;
//   · 每开一层、收一层,告诉主进程(`appHostLayerChanged`),App 只听到「有宿主页开着 / 关了」(`hostPage`),❌ 页里的任何内容。
// 同一层面板也摆数数的来源(useAssistantAppCounts):内置面板那几行的数,按同一份读法读,只交数字。
// 以后别的宿主页(如任务对话)= 再加一种 kind,同一个格子、同一个返回钮。
import { observer } from 'mobx-react-lite';
import { useEffect, useSyncExternalStore } from 'react';
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
import type { AssistantLayerScreen } from '@shared/extensions/assistant-binding';
import type { AppHostLayer } from '@shared/extensions/app-host-layer';
import { AssistantAppCountsSource } from './assistant-app-counts';

type Layers = Readonly<Record<string, AppHostLayer>>;

const NONE: Layers = Object.freeze({});
let current: Layers = NONE;
const listeners = new Set<() => void>();
/** The Apps whose panel is on screen now (a frame mounted for each): only there can a layer be drawn. */
const mounted = new Map<string, number>();

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
export function openAssistantLayer(extensionId: string, screen: AssistantLayerScreen, ownerId: string): void {
  const shell = readAssistantShellBridge()?.getSnapshot();
  if (!shell || shell.ownerId !== ownerId || shell.assistantState !== 'found' || !shell.assistant) {
    throw new Error('This window does not show that account\'s assistant now');
  }
  if (!mounted.get(extensionId)) throw new Error('This App\'s panel is not on screen');
  publish(extensionId, { kind: `assistant-${screen}`, ownerId });
}

/** The host's back control, and every reason it may not stay (account, assistant, the panel gone). */
export function closeAppHostLayer(extensionId: string): void {
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

/** Tests only. */
export function resetAppHostLayersForTest(): void {
  current = NONE;
  mounted.clear();
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
      }
    };
  }, [extensionId]);
  const stale = !!layer && (shell?.ownerId !== layer.ownerId || shell.assistantState !== 'found' || !shell.assistant);
  useEffect(() => {
    if (stale) closeAppHostLayer(extensionId);
  }, [stale, extensionId]);
  return (
    <>
      {readsAssistant(extensionId) ? <AssistantAppCountsSource /> : null}
      {layer && !stale ? <AppHostLayerPage extensionId={extensionId} layer={layer} /> : <ExtensionSharedSlot tabKind={tabKind} tabId="dock" />}
    </>
  );
});

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
