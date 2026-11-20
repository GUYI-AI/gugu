import { observer } from 'mobx-react-lite';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SUBSCRIPTIONS } from '@renderer/features/settings/subscriptions/subscription-queries';
import { refreshAgentReadings } from '@renderer/lib/stores/agent-replicas';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { marketAgentInstallPlan, type MarketAgentInstallPlan } from './market-agent-install-plan';
import { MarketDevicePicker, useMarketDevicePicker } from './market-detail-devices';
import { refreshTag } from '@/lib/replica';

export const MarketAgentDevices = observer(function MarketAgentDevices({ agentId }: { agentId: string }) {
  const { translate } = useSessionMessages();
  const picker = useMarketDevicePicker<AgentPayload | null, MarketAgentInstallPlan>({
    itemKey: `agent:${agentId}`,
    read: ({ host }) => host.agents.getManagement(agentId),
    describe: (agent) => {
      if (!agent) return { state: 'blocked', detail: translate('marketDetail.deviceUnavailable') };
      if (!agent.reading) return { state: 'blocked', detail: translate('extensions.tileNeedsApp') };
      const installed = agent.reading !== 'not-detected';
      const version = agent.version?.replace(/^v/, '');
      const hint = version ? `v${version}` : undefined;
      const plan = marketAgentInstallPlan(agent);
      if (plan) return { state: 'available', plan, detail: installed ? translate('marketDetail.deviceUpdate') : '', hint };
      if (installed) return { state: 'current', detail: translate('marketDetail.deviceInstalled'), hint };
      return { state: 'blocked', detail: translate('marketDetail.deviceIncompatible'), hint: translate('agentsPage.installYourselfHint') };
    },
    install: async ({ host }, plan) => {
      const result = await host.agents[plan.kind](agentId, plan.method, plan.registry) as { success: boolean; error?: unknown } | null;
      if (!result?.success) throw new Error('Agent installation failed', { cause: result?.error });
      return true;
    },
    refresh: async ({ device }) => {
      await refreshAgentReadings(device.id);
      void refreshTag(SUBSCRIPTIONS, device.id, agentId);
    },
  });
  return <MarketDevicePicker {...picker} />;
});
