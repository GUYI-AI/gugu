import type { AgentAppDetailLink } from '@gugu/core/shared/ui/guguLink';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { currentAppsLocation } from './apps-location';

type AgentDetailHost = Window & {
  __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => boolean;
  __GUGU_RESTORE_SESSIONPAGE_AGENT_INSTALL__?: () => void;
};

export function openAgentAppDetail(navigate: NavigateFnTyped, agentId: string, deviceId?: string | null) {
  const agentDetail: AgentAppDetailLink = {
    kind: 'agent-app-detail',
    agentId,
    ...(deviceId ? { deviceId } : {}),
  };
  const fromEmbeddedComposer = (window as AgentDetailHost).__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?.(agentId);
  navigate('apps', { location: { ...currentAppsLocation(), installed: undefined }, agentDetail, ...(fromEmbeddedComposer ? { agentDetailFrom: 'embedded-composer' } : {}) });
}

export function restoreAgentDetailComposer() {
  (window as AgentDetailHost).__GUGU_RESTORE_SESSIONPAGE_AGENT_INSTALL__?.();
}
