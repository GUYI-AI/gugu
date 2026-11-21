import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { AgentInstallationStatus, AgentPayload } from '@shared/core/agents/agent-payload';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { useAgentInstallationStatuses, useBusyInstallAgents, useUninstallingAgents } from '@renderer/lib/stores/use-agent-installation-statuses';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { compareAgents, isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order';
import { useAgentUninstallConfirmation } from '@renderer/features/settings/agents-page/agent-uninstall-confirmation';
import { AppLifecycleButton } from './app-lifecycle-button';
import { AppMoreMenu } from './app-more-menu';
import { installedAgentControl } from '../installed/installed-agent-control';
import { InstalledAppRowLayout } from './app-rows';
import { marketAgentDescription } from './market-agent-description';

type InstalledAgent = { agent: AgentPayload; reading: AgentInstallationStatus };

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
  const { confirmation, requestUninstall } = useAgentUninstallConfirmation();
  const items = rows.map(({ agent, reading }: InstalledAgent) => {
    const agentId = agent.id as AgentProviderId;
    const installing = busy.has(agent.id);
    const removing = uninstalling.has(agent.id);
    const working = installing || removing;
    const { update, canRemove, version, latestVersion, companionUpdate } = installedAgentControl(agent, reading, installing);
    const open = () => onOpenAgentDetail(agent.id);
    const runUpdate = update ? () => {
      const run = update.kind === 'update' ? operations.update : operations.install;
      run({ id: agentId, method: update.method, registry: update.registry });
    } : undefined;
    const uninstall = canRemove
      ? () => requestUninstall(agent.name, () => operations.uninstallAsync({ id: agentId }))
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
        version={version}
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
  return <>{items}{confirmation}</>;
}
