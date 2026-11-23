import { useContext, useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Maximize2 } from '@/lib/icons';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings';
import { remoteHostsStore } from '../remote-hosts/remote-hosts-store';
import { desktopLiveWindowTransport } from './desktop-transport';
import { useLiveWindowConversation } from './use-live-window-conversation';
import { useLiveWindowLabels } from './desktop-labels';
import type { LiveWindowConversation } from './conversation';
import { DetailsGroupTitle } from '@/components/details/DetailsParts';

/**
 * 第 16 版 #43「它的电脑」:详情开头的一张小卡片 —— 缩略图 + 一行状态,只在 agent 真用到浏览器 / 电脑时出现
 * (同一条 live-window 对话,同一个 headerSource 判据,和会话页签条上那颗一样)。点它 = 那颗的同一个动作:打开它的画面。
 */
export const LiveWindowDetailsCard = observer(function LiveWindowDetailsCard({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const binding = sessionAgentBindings.bindingFor(sessionId);
  return binding ? <BoundCard projectId={projectId} sessionId={sessionId} agentId={binding.agentUserId} /> : null;
});

const BoundCard = observer(function BoundCard({ projectId, sessionId, agentId }: { projectId: string; sessionId: string; agentId: string }) {
  const shown = useContext(SurfaceShownContext);
  const t = useLiveWindowLabels();
  const machine = machineRegistry.machineOf(projectId);
  const connected = !machine || remoteHostsStore.connectionState(machine) === 'connected';
  const transport = useMemo(() => desktopLiveWindowTransport(machine), [machine]);
  const live = useLiveWindowConversation({ context: { conversationId: sessionId, sessionId, deviceId: machine ?? 'local', agentId, privateAgentChat: true, shown },
    platform: 'desktop', connected, transport });
  const source = live.headerSource;
  if (!source) return null;
  const status = t(!live.connected ? 'disconnected' : live.operating
    ? source.kind === 'browser' ? 'usingBrowser' : 'usingComputer' : source.kind === 'browser' ? 'web' : 'computer');
  return (
    <>
    <DetailsGroupTitle>{t('computer')}</DetailsGroupTitle>
    <button type="button" data-testid="details-computer-card" data-kind={source.kind} title={t('tab')}
      onClick={() => live.dispatch({ type: 'toggle-window' })}
      className="mx-auto mb-[22px] block w-[260px] overflow-hidden rounded-[14px] bg-[var(--card)] text-left shadow-[0_0_0_1px_var(--border),var(--shadow-lift)]">
      <span aria-hidden className="relative block h-[146px] overflow-hidden bg-[var(--muted)]">
        <LiveFrameMirror conversation={live.conversation} sourceId={source.id} />
      </span>
      <span className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
        <span className={`size-[7px] shrink-0 rounded-full ${live.connected ? 'bg-[var(--green)]' : 'bg-[var(--faint-fg)]'}`} />
        <span className="min-w-0 flex-1 truncate">{status}</span>
        <Maximize2 className="size-3.5 text-[var(--muted-fg)]" />
      </span>
    </button>
    </>
  );
});

/**
 * The source's real picture, as the chat's small live window shows it (img55): the projection paints each frame into one
 * <img> inside the conversation's picture element; this reads that <img>'s current frame — ❌ moving the element (the
 * small window would go blank) or opening a second projection of the same source.
 */
function LiveFrameMirror({ conversation, sourceId }: { conversation: LiveWindowConversation; sourceId: string }) {
  const [frame, setFrame] = useState<string | null>(null);
  const picture = conversation.picture(sourceId);
  useEffect(() => {
    if (!picture) return;
    const read = () => {
      const images = picture.querySelectorAll('img');
      setFrame(images[images.length - 1]?.getAttribute('src') || null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(picture, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    return () => observer.disconnect();
  }, [picture]);
  return frame ? <img alt="" draggable={false} src={frame} className="block h-full w-full object-cover object-top" /> : null;
}
