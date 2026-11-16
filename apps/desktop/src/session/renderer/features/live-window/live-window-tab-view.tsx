import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { IconButton } from '@/components/ui/IconButton';
import { Minimize2 } from '@/lib/icons';
import type { TabContentProps } from '../tabs/core/tab-provider';
import type { LiveWindowTabResource } from './live-window-tab';
import { LiveWindowPicture } from './use-live-window-conversation';
import { useLiveWindowLabels } from './desktop-labels';
import { fitLiveWindow } from './geometry';

export const TabContent = observer(function LiveWindowTabContent({ host }: TabContentProps) {
  const tab = host.resolvedTabs.find(tab => tab.kind === 'live-window' && tab.isActive);
  return tab ? <Screen key={tab.tabId} resource={tab.resource as LiveWindowTabResource} /> : null;
});
function Screen({ resource }: { resource: LiveWindowTabResource }) {
  const { conversation, state } = resource, holder = useId(), shown = useContext(SurfaceShownContext), t = useLiveWindowLabels();
  const snapshot = useSyncExternalStore(conversation.model.subscribe, conversation.model.getSnapshot, conversation.model.getSnapshot);
  const root = useRef<HTMLDivElement>(null), [bounds, setBounds] = useState({ width: 0, height: 0 });
  useEffect(() => { conversation.setVisible(holder, shown); return () => conversation.setVisible(holder, false); }, [conversation, holder, shown]);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  const source = snapshot.sources.find(source => source.id === state.sourceId), fit = fitLiveWindow(source?.size ?? null, bounds);
  return <div className="flex h-full min-h-0 flex-col bg-background-1" data-live-window="tabbed">
    <div className="flex h-10 shrink-0 items-center justify-end px-2">
      <IconButton size="sm" aria-label={t('minimize')} onClick={() => conversation.model.dispatch({ type: 'minimize' })}><Minimize2 /></IconButton>
    </div>
    <div ref={root} className="relative min-h-0 flex-1">
      {fit && <div data-live-window-picture className="absolute" style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }}>
        <LiveWindowPicture conversation={conversation} sourceId={state.sourceId} />
      </div>}
    </div>
  </div>;
}
