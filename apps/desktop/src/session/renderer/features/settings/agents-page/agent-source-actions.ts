import type { AgentPayload, Installation, InstallOption, InstallMethod } from '@shared/core/agents/agent-payload';
import { isManagedInstallOption } from './installation-sources';
import type { HarnessState } from './harness-state';
import { resolveManagedUpdate, resolveUpdateAction } from './update-action';

export function managedInstallOption(options: InstallOption[], registry: string | undefined) {
  return options.find((option) =>
    isManagedInstallOption(option) && (registry === undefined || option.registry === registry)
  ) ?? options.find(isManagedInstallOption);
}

export function resolveManagedSourceUpdate({
  agent,
  managedCopy,
  managedInstall,
  registry,
  companionUpdate,
}: {
  agent: AgentPayload | undefined;
  managedCopy: Installation | undefined;
  managedInstall: { method: InstallMethod } | undefined;
  registry: string | undefined;
  companionUpdate: boolean;
}) {
  if (managedCopy?.updateAvailable) {
    const action = resolveManagedUpdate({
      updateAction: resolveUpdateAction(agent, managedCopy, registry, agent?.id ?? ''),
      managedInstall,
      registry,
    });
    if (action) return action;
  }
  // A companion-only update leaves the primary program in place.
  if (managedCopy && companionUpdate && managedInstall) {
    return { kind: 'update' as const, method: managedInstall.method, registry };
  }
  return null;
}

export function canUninstallManagedSource(
  agent: AgentPayload | undefined,
  installation: Installation | undefined,
  state: HarnessState,
): boolean {
  if (agent?.capabilities.hostDependency.uninstall?.kind !== 'package-manager') return false;
  if (state === 'installing') return false;
  // An installed companion can still be removed if the primary program is missing.
  if (state === 'not-installed' && !agent.programs) return false;
  return installation?.provenance.ours === true;
}
