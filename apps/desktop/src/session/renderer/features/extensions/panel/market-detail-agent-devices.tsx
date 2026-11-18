import { observer } from 'mobx-react-lite';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { managedInstallOption, resolveManagedSourceUpdate } from '@renderer/features/settings/agents-page/agent-source-actions';
import { refreshSubscriptionReadings } from '@renderer/features/settings/subscriptions/subscription-queries';
import type { InstallMethod } from '@shared/core/agents/agent-payload';
import { MarketDevicePicker, useMarketDevicePicker } from './market-detail-devices';

type AgentPlan = { kind: 'install' | 'update'; method: InstallMethod; registry?: string };

export const MarketAgentDevices = observer(function MarketAgentDevices({ agentId }: { agentId: string }) {
  const { translate } = useSessionMessages();
  const client = useQueryClient();
  const picker = useMarketDevicePicker({
    itemKey: `agent:${agentId}`,
    read: ({ host }) => host.agents.getManagement(agentId),
    describe: (agent) => {
      if (!agent) return { state: 'blocked', detail: translate('marketDetail.deviceUnavailable') };
      if (!agent.reading) return { state: 'blocked', detail: translate('extensions.tileNeedsApp') };
      const installed = agent.reading !== 'not-detected';
      const registry = agent.used?.registry;
      const managedInstall = managedInstallOption(agent.installOptions ?? [], registry);
      const managedCopy = agent.installations?.find((entry) => entry.provenance.ours);
      const update = resolveManagedSourceUpdate({
        agent, managedCopy, managedInstall, registry,
        companionUpdate: agent.programs?.slice(1).some((entry) => entry.managedUpdateAvailable) ?? false,
      });
      const version = agent.version?.replace(/^v/, '');
      if (installed && update) {
        return {
          state: 'available', plan: update,
          detail: version ? translate('marketDetail.deviceUpdate', { version }) : translate('agentsPage.updateAvailable'),
        };
      }
      if (installed) return { state: 'current', detail: version ? `v${version}` : translate('marketDetail.deviceInstalled') };
      if (!managedInstall) return { state: 'blocked', detail: translate('agentsPage.installYourselfHint') };
      return {
        state: 'available', detail: translate('marketDetail.deviceNotInstalled'),
        plan: { kind: 'install', method: managedInstall.method, registry },
      };
    },
    install: async ({ host }, plan: AgentPlan) => {
      const result = await host.agents[plan.kind](agentId, plan.method, plan.registry) as { success: boolean; error?: unknown } | null;
      if (!result?.success) throw new Error('Agent installation failed', { cause: result?.error });
      return true;
    },
    refresh: async ({ device }) => {
      await client.invalidateQueries({ queryKey: ['agents'] });
      void refreshSubscriptionReadings(device.id, agentId);
    },
  });
  return <MarketDevicePicker {...picker} />;
});
