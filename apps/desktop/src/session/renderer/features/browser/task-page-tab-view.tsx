import { observer } from 'mobx-react-lite';
import { useContext, useEffect, useRef, useState } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { events, rpc } from '@renderer/lib/ipc';
import { browserTaskPagePacketChannel } from '@shared/events/browserEvents';
import type { ProjectionHost } from '@/session/app-runtime/projection-source';
import { mountProjection, type ProjectionViewState } from '@/session/app-runtime/projection-view';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import type { TaskPageResource } from './task-page-tab';

/**
 * The task page's picture fills the tab, as the page itself does on the computer it is on: the shared projection view
 * (picture, pointer, keys, IME text), fed over this computer's connection to that machine (`rpc.browser.watchTaskPage`).
 */
function taskPageHost(deviceId: string, sessionId: string): ProjectionHost {
  return {
    projection: {
      watch: ({ watchId }) => rpc.browser.watchTaskPage({ watchId, deviceId, sessionId }).then(() => undefined),
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

function TaskPageScreen({ resource, visible }: { resource: TaskPageResource; visible: boolean }) {
  const { translate } = useSessionMessages();
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ProjectionViewState>('connecting');
  // Watched only while on screen: a hidden tab costs that machine nothing.
  useEffect(() => {
    if (!visible || !root.current) return;
    let mounted: Awaited<ReturnType<typeof mountProjection>> | null = null;
    let gone = false;
    setState('connecting');
    void mountProjection(taskPageHost(resource.deviceId, resource.sessionId), root.current, `${resource.deviceId}:${resource.sessionId}`, {
      state: (next) => setState(next),
      error: () => setState('closed'),
    }).then((view) => { if (gone) void view.close(); else mounted = view; }, () => setState('closed'));
    return () => { gone = true; void mounted?.close(); };
  }, [resource, visible]);
  return (
    <div data-theme="light" className="emlight relative h-full bg-background">
      <div ref={root} className="absolute inset-0" />
      {state !== 'live' && state !== 'input-paused' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-foreground-muted">
          {translate(state === 'closed' ? 'browser.sessionUnavailable' : 'browser.preparingSession')}
        </div>
      )}
    </div>
  );
}

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
