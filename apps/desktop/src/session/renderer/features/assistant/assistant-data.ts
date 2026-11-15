import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel';
import { useMemo } from 'react';
import { useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files';
import { appState } from '@renderer/lib/stores/app-state';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { homeSessions } from './assistant-home-sessions';
import { isAssistantSession } from './assistant-lineage';

export type { MemoryEntry } from './assistant-machine';

export type MachineReadiness =
  /** 线连着,可以读。 */
  | 'ready'
  /** 它住的云端宿主收回着:要读就得叫起来(由读的那一块交给系统去叫,❌ 让人按)。 */
  | 'asleep'
  /** 正在叫醒 / 连接中:等一会儿就好。 */
  | 'waiting'
  /** 叫不醒、离线、版本不对:读不了,原因由页上那句说。 */
  | 'unreachable';

/**
 * 助理那条会话跑在哪个目录:会话目录里它自己那一行 → 那个项目的路径。读的是会话目录(列出不挂载),所以是 observer 里调。
 * pending = 目录还不是此刻的读数(刚连上);missing = 此刻的目录里没有它的会话(如实说,❌ 退回主目录去读一片空)。
 */
export type AssistantWorkdir = { state: 'found'; path: string } | { state: 'pending' } | { state: 'missing' };

export function assistantWorkdir(home: AssistantHomePlace, assistantId: string): AssistantWorkdir {
  const { sessions, live } = homeSessions(home);
  const own = sessions.find((session) => isAssistantSession(session, assistantId));
  const project = own ? appState.projects.projects.get(own.projectId)?.data : null;
  const path = own?.cwd ?? (project?.kind !== 'workspace' ? project?.path ?? null : null);
  if (path) return { state: 'found', path };
  return live ? { state: 'missing' } : { state: 'pending' };
}

export function useAssistantMachine(assistantId: string | null, chatId: string | null, home: AssistantHomePlace | null, chatReadFailed = false) {
  const data = useCloudAssistantFiles(assistantId,chatId,home?.deviceId ?? null);
  const isLoading = !!assistantId && !!home?.deviceId && !chatId && !chatReadFailed;
  const error = useMemo(() => data || isLoading ? null : new AssistantPanelError(home?.deviceId ? 'missing-identity' : 'missing-home','PANEL_IDENTITY_UNAVAILABLE'),[data,home?.deviceId,isLoading]);
  return { data,isLoading,error,refetch: () => data?.panel?.invalidate() };
}
