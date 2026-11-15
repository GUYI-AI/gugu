import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { observer } from 'mobx-react-lite';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { usePaneContext } from '../tabs/pane-context';
import { usePaneLayoutContext } from '../tabs/pane-layout-context';
import type { SessionTabContext } from '../tabs/core/session-tab-context';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings';
import { desktopLiveWindowTransport } from './desktop-transport';
import { liveWindowConversationKey, useLiveWindowConversation } from './use-live-window-conversation';
import type { LiveWindowContext } from './types';
import type { LiveWindowTabResource } from './live-window-tab';
import { DesktopLiveWindow } from './DesktopLiveWindow';
import { bindDesktopLiveWindowActivity } from './desktop-context';

export const DesktopLiveWindowConversation = observer(function DesktopLiveWindowConversation({ kind, children }: {
  kind: 'acp-chat' | 'session'; children: ReactNode;
}) {
  const { pane } = usePaneContext();
  const [reserved, setReserved] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const context = pane.ctx as SessionTabContext;
  const entries = [...pane.entries.values()].filter(entry => entry.kind === kind);
  return <div ref={surface} className="relative h-full min-h-0" data-live-window-conversation>
    <div className="h-full min-w-0" style={{ marginRight: reserved }}>{children}</div>
    {entries.map(entry => <BoundWindow key={entry.tabId} chatTabId={entry.tabId}
      sessionId={(entry.state as { sessionId: string }).sessionId} projectId={context.projectId}
      shown={pane.resolvedTabs.some(tab => tab.tabId === entry.tabId && tab.isActive)} onWidth={setReserved} surface={surface} />)}
  </div>;
});

const BoundWindow = observer(function BoundWindow({ chatTabId, sessionId, projectId, shown, onWidth, surface }: {
  chatTabId: string; sessionId: string; projectId: string; shown: boolean; onWidth(width: number): void; surface: RefObject<HTMLDivElement | null>;
}) {
  const { pane, paneId } = usePaneContext(), layout = usePaneLayoutContext();
  const pageShown = useContext(SurfaceShownContext);
  const machine = machineRegistry.machineOf(projectId);
  const agentId = sessionAgentBindings.bindingFor(sessionId)?.agentUserId ?? sessionId;
  const context: LiveWindowContext = { conversationId: sessionId, deviceId: machine ?? 'local', sessionId, agentId,
    privateAgentChat: true, shown: shown && pageShown };
  const key = liveWindowConversationKey(context);
  const screenShown = pane.resolvedTabs.some(tab => tab.isActive && tab.kind === 'live-window'
    && (tab.resource as LiveWindowTabResource).state.conversationKey === key);
  context.shown = (shown || screenShown) && pageShown;
  const transport = useMemo(() => desktopLiveWindowTransport(machine), [machine]);
  // The lifetime-bound host observer remains authoritative when another tab evicts this chat's React view.
  const live = useLiveWindowConversation({ context, platform: 'desktop', transport });
  useEffect(() => { bindDesktopLiveWindowActivity(live.conversation); }, [live.conversation]);
  const mode = live.presentation?.mode;
  useEffect(() => { if (shown) live.dispatch({ type: 'select-tab', tab: 'chat' }); }, [shown, live.conversation]);
  useEffect(() => {
    const matching = pane.resolvedTabs.filter(tab => tab.kind === 'live-window'
      && (tab.resource as LiveWindowTabResource).state.conversationKey === key);
    if (mode !== 'tabbed') {
      if (matching.some(tab => tab.isActive)) pane.setActiveTab(chatTabId);
      for (const tab of matching) pane.closeTab(tab.tabId);
      return;
    }
    for (const source of live.sources) {
      if (!matching.some(tab => (tab.resource as LiveWindowTabResource).state.sourceId === source.id)) {
        layout.open('live-window', { conversationKey: key, sourceId: source.id, chatTabId },
          { from: chatTabId, intent: 'newTab', activate: false, target: { paneId } });
      }
    }
    for (const tab of matching) if (!live.sources.some(source => source.id === (tab.resource as LiveWindowTabResource).state.sourceId)) pane.closeTab(tab.tabId);
    if (live.presentation?.selectedTab === 'screen') {
      const selected = pane.resolvedTabs.find(tab => tab.kind === 'live-window'
        && (tab.resource as LiveWindowTabResource).state.conversationKey === key
        && (tab.resource as LiveWindowTabResource).state.sourceId === live.presentation?.selectedSourceId);
      if (selected && !selected.isActive) pane.setActiveTab(selected.tabId);
    }
  }, [mode, live.sources, live.presentation?.selectedTab, live.presentation?.selectedSourceId, pane, layout, paneId, key, chatTabId]);
  useEffect(() => {
    const root = surface.current;
    if (!root) return;
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (!shown || target.closest('[data-live-window-picture]')) return;
      if (target.matches('textarea,[contenteditable="true"],input') && target.closest('[data-session-chat-surface],[data-region="composer"],.xterm')) live.dispatch({ type: 'composer-focus' });
    };
    const tool = (event: Event) => {
      if (!shown) return;
      const names = (event as CustomEvent<{ toolNames?: unknown }>).detail?.toolNames;
      if (!Array.isArray(names)) return;
      const kind = [...names].reverse().map(name => typeof name !== 'string' ? null
        : /(?:^|__)computer[-_]use__/.test(name) ? 'computer' as const
          : /(?:^|__)browser[-_]use__/.test(name) ? 'browser' as const : null).find(Boolean);
      if (!kind) return;
      live.dispatch({ type: 'show-from-tool', kind });
      if (live.conversation.model.getSnapshot().source?.kind === kind) event.preventDefault();
    };
    root.addEventListener('focusin', focus); root.addEventListener('session-tool-activation', tool);
    return () => { root.removeEventListener('focusin', focus); root.removeEventListener('session-tool-activation', tool); };
  }, [surface, shown, live.conversation]);
  return <div data-live-window-chat={chatTabId} className="contents">
    {live.visible && live.source && live.presentation && mode !== 'tabbed' && <DesktopLiveWindow
      source={live.sources.find(source => source.id === live.source?.id)!} sources={live.sources} state={live.presentation} dispatch={live.dispatch} onWidth={onWidth} />}
  </div>;
});
