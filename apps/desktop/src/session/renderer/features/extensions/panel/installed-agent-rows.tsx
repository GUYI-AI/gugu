import { useAgentInstallationStatuses, useBusyInstallAgents, useUninstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { compareAgents, isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';

export function useInstalledAgentRows(query: string) {
  const inventory = useManagementAgents();
  const operations = useAgentInstallationStatuses();
  const busy = useBusyInstallAgents();
  const uninstalling = useUninstallingAgents();
  const readings = new Map(operations.data?.map((reading) => [reading.id, reading]));
  const installed = (inventory.data ?? [])
    .map((agent) => ({ agent, reading: readings.get(agent.id) ?? agent }))
    .filter(({ reading }) => isInstalledAgent(reading))
    .sort((a, b) => compareAgents(a.agent, b.agent));

  const normalizedQuery = query.trim().toLowerCase();
  return {
    rows: installed.filter(({ agent }) => !normalizedQuery || agent.name.toLowerCase().includes(normalizedQuery)),
    inventory,
    operations,
    busy,
    uninstalling,
  };
}
