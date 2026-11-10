import { observer } from 'mobx-react-lite';
import { useContext, useEffect, useRef, useState } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { events, rpc } from '@renderer/lib/ipc';
import { browserTaskPagePacketChannel, browserTaskPageStateChannel } from '@shared/events/browserEvents';
import type { TaskPageControl } from '@shared/browser-task-page';
import type { ProjectionHost } from '@/session/app-runtime/projection-source';
import { mountProjection, type ProjectionViewState } from '@/session/app-runtime/projection-view';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { BrowserToolbar } from './browser-toolbar';
import type { TaskPageResource } from './task-page-tab';

/**
 * The task page's picture fills the tab, as the page itself does on the computer it is on: the shared projection view
 * (picture, pointer, keys, IME text), fed over this computer's connection to that machine (`rpc.browser.watchTaskPage`).
 */
function taskPageHost(deviceId: string, sessionId: string, watching: { asked(watchId: string): void; answered(watchId: string): void }): ProjectionHost {
  return {
    projection: {
      watch: ({ watchId }) => {
        watching.asked(watchId);
        return rpc.browser.watchTaskPage({ watchId, deviceId, sessionId }).then(() => watching.answered(watchId));
      },
      unwatch: ({ watchId }) => rpc.browser.unwatchTaskPage(watchId).then(() => undefined),
      send: ({ watchId, packet }) => rpc.browser.sendTaskPage({ watchId, packet }),
      create: () => Promise.reject(new Error('A task page is only watched here')),
      publish: () => Promise.reject(new Error('A task page is only watched here')),
      close: () => Promise.resolve(),
      closed: () => Promise.resolve(),
      inputResult: () => Promise.resolve(),
    },
    onProjection: (handler) => events.on(browserTaskPagePacketChannel, ({ watchId, packet }) => handler(watchId, packet)),
  };
}

/**
 * The same tab as a page on this computer: the browser toolbar on top (back, forward, reload, address), the page filling
 * the rest. The page there lays out to this tab's size, so its picture fills it as the page itself would.
 */
const TaskPageScreen = observer(function TaskPageScreen({ resource, visible }: { resource: TaskPageResource; visible: boolean }) {
  const { translate } = useSessionMessages();
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ProjectionViewState>('connecting');
  const [watchId, setWatchId] = useState<string | null>(null);
  // Watched only while on screen: a hidden tab costs that machine nothing.
  useEffect(() => {
    if (!visible || !root.current) return;
    let mounted: Awaited<ReturnType<typeof mountProjection>> | null = null;
    let gone = false;
    setState('connecting');
    // The toolbar follows the watch this tab opened. Its first state can come before the answer: listen from the ask.
    let current: string | null = null;
    const host = taskPageHost(resource.deviceId, resource.sessionId, {
      asked: (id) => { current = id; },
      answered: (id) => { if (!gone && current === id) setWatchId(id); },
    });
    const offState = events.on(browserTaskPageStateChannel, ({ watchId: id, state: page }) => {
      if (id === current) resource.setPage(page);
    });
    void mountProjection(host, root.current, `${resource.deviceId}:${resource.sessionId}`, {
      state: (next) => setState(next),
      error: () => setState('closed'),
    }).then((view) => { if (gone) void view.close(); else mounted = view; }, () => setState('closed'));
    return () => { gone = true; offState(); setWatchId(null); void mounted?.close(); };
  }, [resource, visible]);

  const control = (next: TaskPageControl) => {
    if (watchId) void rpc.browser.controlTaskPage({ watchId, control: next }).catch(() => undefined);
  };
  // The page there takes this tab's size (CSS pixels, at this screen's density, as a page here would).
  useEffect(() => {
    const element = root.current;
    if (!watchId || !element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width < 100 || height < 100) return;
      void rpc.browser.controlTaskPage({ watchId, control: { action: 'resize', width: Math.round(width), height: Math.round(height),
        scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) } }).catch(() => undefined);
    };
    const observer = new ResizeObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(resize, 120); });
    observer.observe(element);
    resize();
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [watchId]);

  const session = resource.session;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {session && (
        <BrowserToolbar
          session={session}
          adapter={null}
          remote
          onNavigate={(url) => { control({ action: 'navigate', url }); return true; }}
          onGoBack={() => control({ action: 'back' })}
          onGoForward={() => control({ action: 'forward' })}
          onReload={() => control({ action: session.isLoading ? 'stop' : 'reload' })}
          onForceReload={() => control({ action: 'reload' })}
        />
      )}
      <div data-theme="light" className="emlight relative min-h-0 flex-1 bg-background">
        <div ref={root} className="absolute inset-0" />
        {state !== 'live' && state !== 'input-paused' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-foreground-muted">
            {translate(state === 'closed' ? 'browser.sessionUnavailable' : 'browser.preparingSession')}
          </div>
        )}
      </div>
    </div>
  );
});

export const TabContent = observer(function TaskPageTabContent({ host }: TabContentProps) {
  const pageActive = useContext(PageShownContext);
  const tabs = host.resolvedTabs.filter((t): t is ResolvedTab<TaskPageResource> => t.kind === 'task-page');
  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.tabId} className="absolute" style={tab.isActive ? { inset: 0 } : RETAINED_SURFACE_HIDDEN_STYLE} data-pane-tab={tab.tabId}>
          <TaskPageScreen resource={tab.resource} visible={tab.isActive && pageActive} />
        </div>
      ))}
    </>
  );
});
