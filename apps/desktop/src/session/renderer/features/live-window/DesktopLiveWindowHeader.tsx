import { useContext, useEffect, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings';
import { remoteHostsStore } from '../remote-hosts/remote-hosts-store';
import { bindDesktopLiveWindowActivity } from './desktop-context';
import { desktopLiveWindowTransport } from './desktop-transport';
import { useLiveWindowConversation } from './use-live-window-conversation';
import { LiveWindowHeaderIcon } from './LiveWindowHeaderIcon';
import { PaneContext } from '../tabs/pane-context';

/** Mounted in the private task's header, never the ChatBlock/ProjectBlock group action slots. */
export const DesktopLiveWindowHeader = observer(function DesktopLiveWindowHeader({ projectId, sessionId }: { projectId: string; sessionId?: string }) {
  const shown = useContext(SurfaceShownContext);
  const pane = useContext(PaneContext)?.pane;
  const binding = sessionId ? sessionAgentBindings.bindingFor(sessionId) : undefined;
  const privateChatShown = pane?.resolvedTabs.some(tab => tab.isActive && (tab.kind === 'session' || tab.kind === 'acp-chat')
    && (pane.entries.get(tab.tabId)?.state as { sessionId?: string } | undefined)?.sessionId === sessionId);
  if (!sessionId || !binding || !privateChatShown) return null;
  return <BoundHeader projectId={projectId} sessionId={sessionId} agentId={binding.agentUserId} shown={shown} />;
});

const BoundHeader = observer(function BoundHeader({ projectId, sessionId, agentId, shown }: {
  projectId: string; sessionId: string; agentId: string; shown: boolean;
}) {
  const machine = machineRegistry.machineOf(projectId);
  const connected = !machine || remoteHostsStore.connectionState(machine) === 'connected';
  const transport = useMemo(() => desktopLiveWindowTransport(machine), [machine]);
  const live = useLiveWindowConversation({ context: { conversationId: sessionId, sessionId, deviceId: machine ?? 'local', agentId, privateAgentChat: true, shown },
    platform: 'desktop', connected, transport });
  useEffect(() => { bindDesktopLiveWindowActivity(live.conversation); }, [live.conversation]);
  return <LiveWindowHeaderIcon snapshot={live} dispatch={live.dispatch} />;
});
