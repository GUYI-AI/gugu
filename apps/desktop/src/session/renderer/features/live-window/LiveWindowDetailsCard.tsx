import { useContext, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { Maximize2 } from '@/lib/icons';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings';
import { remoteHostsStore } from '../remote-hosts/remote-hosts-store';
import { desktopLiveWindowTransport } from './desktop-transport';
import { useLiveWindowConversation } from './use-live-window-conversation';
import { useLiveWindowLabels } from './desktop-labels';
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
      <span aria-hidden className="relative block h-[146px] bg-[var(--muted)] px-3 pt-2.5">
        <span className="absolute inset-x-3 top-2.5 bottom-0 rounded-t-[7px] bg-[var(--bg)] shadow-[0_0_0_.5px_var(--border-strong)]">
          <span className="flex h-4 items-center gap-[3px] border-b border-[var(--border)] px-1.5">
            <span className="ms-1.5 h-[9px] flex-1 truncate rounded-[5px] bg-[var(--muted)] ps-[5px] text-[7px] leading-[9px] text-[var(--faint-fg)]">{source.title}</span>
          </span>
          {[55, 82, 74, 66, 78].map((width, index) => <span key={index} className="mx-2.5 mt-[7px] block h-1.5 rounded-[3px] bg-[var(--muted)]" style={{ width: `${width}%` }} />)}
        </span>
      </span>
      <span className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
        <span className={`size-[7px] shrink-0 rounded-full ${live.connected ? 'bg-[var(--live)]' : 'bg-[var(--faint-fg)]'}`} />
        <span className="min-w-0 flex-1 truncate">{status}</span>
        <Maximize2 className="size-3.5 text-[var(--muted-fg)]" />
      </span>
    </button>
    </>
  );
});
