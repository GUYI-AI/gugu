import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { AgentInstallationStatus, AgentPayload } from '@shared/core/agents/agent-payload';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { useAgentInstallationStatuses, useBusyInstallAgents, useUninstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareAgents, isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';
import { canUninstallManagedSource, managedInstallOption, resolveManagedSourceUpdate } from '@renderer/features/settings/agents-page/agent-source-actions';
import { resolveHarnessState } from '@renderer/features/settings/agents-page/harness-state';
import { describedInstallation, liveRefFor } from '@renderer/features/settings/agents-page/installation-sources';
import { uninstallAgentWithToast } from '@renderer/features/settings/agents-page/uninstall-agent-with-toast';
import { AppLifecycleButton } from './app-lifecycle-button';
import { AppMoreMenu } from './app-more-menu';
import { InstalledAppRowLayout } from './app-rows';
import { marketAgentDescription } from './market-agent-description';

type InstalledAgent = { agent: AgentPayload; reading: AgentInstallationStatus };

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

export function InstalledAgentRows({
  inventory: { rows, operations, busy, uninstalling },
  onOpenAgentDetail,
  readOnly,
}: {
  inventory: ReturnType<typeof useInstalledAgentRows>;
  onOpenAgentDetail: (agentId: string) => void;
  readOnly: boolean;
}) {
  const { translate, locale } = useSessionMessages();
  return rows.map(({ agent, reading }: InstalledAgent) => {
    const agentId = agent.id as AgentProviderId;
    const registry = reading.used?.registry;
    const active = describedInstallation({
      installations: reading.installations,
      selectedSource: liveRefFor(reading.used, reading.installations),
      overrideEmpty: false,
    });
    const managedCopy = reading.installations.find((installation) => installation.provenance.ours === true);
    const managedInstall = managedInstallOption(agent.installOptions, registry);
    const companionUpdate = reading.programs?.slice(1).some((program) => program.managedUpdateAvailable) ?? false;
    const activeUpdate = active?.updateAvailable ?? reading.updateAvailable;
    const managedUpdate = resolveManagedSourceUpdate({ agent, managedCopy, managedInstall, registry, companionUpdate });
    const update = active?.provenance.ours === true && managedUpdate
      ? managedUpdate
      : (activeUpdate || companionUpdate) && managedInstall
        ? { kind: 'install' as const, method: managedInstall.method, registry }
        : null;
    // A companion update does not report a new version of the primary program.
    const latestVersion = activeUpdate && (active?.latestVersion ?? reading.latestVersion);
    const installing = busy.has(agent.id);
    const removing = uninstalling.has(agent.id);
    const working = installing || removing;
    const state = resolveHarnessState({
      reading: reading.reading,
      status: reading.status,
      busy: installing,
      updateAvailable: activeUpdate || companionUpdate,
    });
    const open = () => onOpenAgentDetail(agent.id);
    const runUpdate = update ? () => {
      const run = update.kind === 'update' ? operations.update : operations.install;
      run({ id: agentId, method: update.method, registry: update.registry });
    } : undefined;
    const uninstall = canUninstallManagedSource(agent, managedCopy, state)
      ? () => uninstallAgentWithToast(agent.name, () => operations.uninstallAsync({ id: agentId }), translate)
      : undefined;
    let line: string;
    if (removing) line = translate('extensions.uninstalling');
    else if (installing) line = translate('extensions.installing');
    else if (latestVersion) line = translate('extensions.rowHasUpdate', { version: latestVersion });
    else if (companionUpdate) line = translate('agentsPage.updateAvailable');
    else line = marketAgentDescription(agent, locale);
    return (
      <InstalledAppRowLayout
        key={agent.id}
        name={agent.name}
        version={active?.version ?? reading.version}
        line={<span>{line}</span>}
        icon={<AppIcon id={agent.id} size={40} />}
        busy={working}
        translate={translate}
        onOpen={readOnly ? undefined : open}
        testId={`installed-agent-row-${agent.id}`}
      >
        <AppLifecycleButton
          state={{ kind: 'open' }}
          translate={translate}
          onClick={open}
          disabled={readOnly}
          testId={`installed-agent-open-${agent.id}`}
        />
        <span className="mk-switch-slot" aria-hidden />
        {runUpdate || uninstall ? (
          <AppMoreMenu
            name={agent.name}
            enabled
            docked={false}
            disabled={working || readOnly}
            translate={translate}
            onUpdate={runUpdate}
            onUninstall={uninstall}
            testId={`installed-agent-more-${agent.id}`}
          />
        ) : <span className="size-7 shrink-0" aria-hidden />}
      </InstalledAppRowLayout>
    );
  });
}
