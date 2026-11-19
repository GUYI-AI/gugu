import type { AgentInstallationStatus, AgentPayload } from '@shared/core/agents/agent-payload'
import { canUninstallManagedSource, managedInstallOption, resolveManagedSourceUpdate } from '@renderer/features/settings/agents-page/agent-source-actions'
import { resolveHarnessState } from '@renderer/features/settings/agents-page/harness-state'
import { describedInstallation, liveRefFor } from '@renderer/features/settings/agents-page/installation-sources'

export function installedAgentControl(agent: AgentPayload, reading: AgentInstallationStatus, installing: boolean) {
  const registry = reading.used?.registry
  const active = describedInstallation({
    installations: reading.installations,
    selectedSource: liveRefFor(reading.used, reading.installations),
    overrideEmpty: false,
  })
  const managedCopy = reading.installations.find((installation) => installation.provenance.ours === true)
  const managedInstall = managedInstallOption(agent.installOptions, registry)
  const companionUpdate = reading.programs?.slice(1).some((program) => program.managedUpdateAvailable) ?? false
  const activeUpdate = active?.updateAvailable ?? reading.updateAvailable
  const managedUpdate = resolveManagedSourceUpdate({ agent, managedCopy, managedInstall, registry, companionUpdate })
  const update = active?.provenance.ours === true && managedUpdate
    ? managedUpdate
    : (activeUpdate || companionUpdate) && managedInstall
      ? { kind: 'install' as const, method: managedInstall.method, registry }
      : null
  const state = resolveHarnessState({
    reading: reading.reading,
    status: reading.status,
    busy: installing,
    updateAvailable: activeUpdate || companionUpdate,
  })
  return {
    update,
    canRemove: canUninstallManagedSource(agent, managedCopy, state),
    version: active?.version ?? reading.version,
    latestVersion: activeUpdate && (active?.latestVersion ?? reading.latestVersion),
    companionUpdate,
  }
}
