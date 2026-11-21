import { useAgentInstallationStatuses, useBusyInstallAgents, useUninstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { compareAgents, isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';

export function useInstalledAgentRows(query: string) {
  const inventory = useManagementAgents();
  const operations = useAgentInstallationStatuses();
  const busy = useBusyInstallAgents();
  const uninstalling = useUninstallingAgents();
  // Until the install statuses are read, each agent's own payload says whether it is installed.
  const statuses = operations.reading.state === 'value' ? new Map(operations.reading.value.map((reading) => [reading.id, reading])) : null;
  const agents = inventory.state === 'value' ? inventory.value : [];
  const installed = agents
    .map((agent) => ({ agent, reading: statuses?.get(agent.id) ?? agent }))
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
