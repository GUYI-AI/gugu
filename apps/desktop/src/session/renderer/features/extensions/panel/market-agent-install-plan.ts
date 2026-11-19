import type { AgentPayload, InstallMethod } from '@shared/core/agents/agent-payload';
import { managedInstallOption, resolveManagedSourceUpdate } from '@renderer/features/settings/agents-page/agent-source-actions';

export type MarketAgentInstallPlan = { kind: 'install' | 'update'; method: InstallMethod; registry?: string };

export function marketAgentInstallPlan(agent: AgentPayload): MarketAgentInstallPlan | null {
  if (!agent.reading) return null;
  const registry = agent.used?.registry;
  const managedInstall = managedInstallOption(agent.installOptions ?? [], registry);
  if (agent.reading === 'not-detected') {
    return managedInstall ? { kind: 'install', method: managedInstall.method, registry } : null;
  }
  return resolveManagedSourceUpdate({
    agent,
    managedCopy: agent.installations?.find((entry) => entry.provenance.ours),
    managedInstall,
    registry,
    companionUpdate: agent.programs?.slice(1).some((entry) => entry.managedUpdateAvailable) ?? false,
  });
}
