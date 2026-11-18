import { AppIcon } from '@renderer/lib/components/app-icon';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { useManagementAgent } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { agentMarketCategoryOf } from '@shared/extensions/catalog';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { remoteHostReachable, type RemoteHostDevice } from '@shared/remote-hosts';
import { InstallSection, type AgentInstallationHeader } from '@renderer/features/settings/agents-page/InstallSection';
import { uninstallAgentWithToast } from '@renderer/features/settings/agents-page/uninstall-agent-with-toast';
import { MarketDetailCard, useMarketDetailConfirmation } from './market-detail-dialog';
import { MarketDetailDeviceRow, MarketDetailDevices } from './market-detail-devices';
import { marketAgentDescription } from './market-agent-description';

const SOURCE_LABELS = {
  local: 'agentsPage.sourceLocal',
  managed: 'agentsPage.sourceManaged',
  custom: 'agentsPage.sourceCustom',
} as const;

function agentVersion(version: string | null | undefined) {
  return version ? `v${version.replace(/^v/, '')}` : null;
}

export function MarketAgentDetail({ agentId, onCreate }: { agentId: string; onCreate: () => void }) {
  const { translate } = useSessionMessages();
  const query = useManagementAgent(agentId);
  if (!query.data) {
    return (
      <DialogHeader>
        <DialogTitle role="status">{translate(
          query.isPending ? 'extensions.loading' : query.isError ? 'agentsPage.detailLoadFailed' : 'agentsPage.detailUnavailable'
        )}</DialogTitle>
      </DialogHeader>
    );
  }
  const agent = query.data;
  return (
    <InstallSection
      agentId={agentId}
      agentPayload={agent}
      installOptions={agent.installOptions}
      renderPage={(installation) => <AgentCard agent={agent} installation={installation} onCreate={onCreate} />}
    />
  );
}

function AgentCard({ agent, installation, onCreate }: {
  agent: AgentPayload;
  installation: AgentInstallationHeader;
  onCreate: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const confirm = useMarketDetailConfirmation();
  const { installed, runnable, install, update, uninstall, busy, installing, updating, uninstalling, version, source } = installation;
  const uninstallHere = async () => {
    if (uninstall && await confirm({
      title: translate('extensions.uninstallConfirmTitle', { name: agent.name }),
      description: translate('marketDetail.agentUninstallBody', { name: agent.name }),
      confirmLabel: translate('extensions.uninstallAction'),
      variant: 'destructive',
    })) uninstallAgentWithToast(agent.name, uninstall, translate);
  };

  const actions = installing || updating || uninstalling ? (
    <Button disabled aria-busy>
      <Spinner size="sm" />
      {translate(uninstalling ? 'extensions.uninstalling' : updating ? 'marketDetail.updating' : 'agentsPage.installingToGuguHome')}
    </Button>
  ) : installed ? (
    <>
      <Button disabled={busy || !runnable} onClick={onCreate}>{translate('sidebar.createAgent')}</Button>
      {update && <Button variant="outline" disabled={busy} onClick={update}>{translate('extensions.updateAction')}</Button>}
    </>
  ) : update || install ? (
    <Button disabled={busy} onClick={update ?? install}>{translate(update ? 'extensions.updateAction' : 'extensions.installAction')}</Button>
  ) : agent.installDocs ? (
    <Button variant="outline" onClick={() => { if (agent.installDocs) confirmOpenExternalLink(agent.installDocs); }}>
      {translate('agentsPage.installDocsLink')}
    </Button>
  ) : undefined;

  return (
    <MarketDetailCard
      name={agent.name}
      publisher={agent.publisher ? translate('marketDetail.agentPublisher', { publisher: agent.publisher }) : undefined}
      icon={<AppIcon id={agent.id} size={68} dimmed={!installed} />}
      actions={actions}
      devices={<MarketDetailDevices>{(device, waking) => <OtherAgent agentId={agent.id} device={device} waking={waking} />}</MarketDetailDevices>}
      facts={[
        { label: translate('extensions.stripVersion'), value: agentVersion(version) ?? '—' },
        { label: translate('agentsPage.sourceHeading'), value: source ? translate(SOURCE_LABELS[source]) : '—' },
        { label: translate('extensions.infoCategory'), value: translate(agentMarketCategoryOf(agent.id) === 'general' ? 'agentsPage.detailGeneral' : 'agentsPage.detailCoding') },
      ]}
      subtitle={marketAgentDescription(agent, locale)}
      onUninstall={uninstall && !busy ? () => void uninstallHere() : undefined}
    />
  );
}

function OtherAgent({ agentId, device, waking }: { agentId: string; device: RemoteHostDevice; waking: boolean }) {
  const { translate } = useSessionMessages();
  const query = useManagementAgent(agentId, { retry: false });
  const agent = query.error ? null : query.data;
  if (!agent || !remoteHostReachable(device)) {
    return <MarketDetailDeviceRow
      device={device}
      waking={waking}
      status={query.isError || query.isSuccess ? translate('marketDetail.deviceUnavailable') : remoteHostReachable(device) ? translate('extensions.loading') : undefined}
      action={waking ? <Button size="sm" variant="outline" disabled>{translate('extensions.installAction')}</Button> : undefined}
    />;
  }
  return (
    <InstallSection
      agentId={agentId}
      agentPayload={agent}
      marketDevice={device.label}
      installOptions={agent.installOptions}
      renderPage={(installation) => <OtherAgentStatus device={device} installation={installation} />}
    />
  );
}

function OtherAgentStatus({ device, installation }: { device: RemoteHostDevice; installation: AgentInstallationHeader }) {
  const { translate } = useSessionMessages();
  const { version, installed, install, update, busy, installing, updating } = installation;
  const run = installed ? update : install;
  return (
    <MarketDetailDeviceRow
      device={device}
      waking={false}
      status={agentVersion(version) ?? translate(installed ? 'marketDetail.deviceInstalled' : 'marketDetail.deviceNotInstalled')}
      action={run || busy ? (
        <Button size="sm" variant="outline" disabled={busy} aria-busy={busy || undefined} onClick={run}>
          {busy && <Spinner size="sm" />}
          {translate(installing ? 'agentsPage.installingToGuguHome' : updating ? 'marketDetail.updating' : installed ? 'extensions.updateAction' : 'extensions.installAction')}
        </Button>
      ) : undefined}
    />
  );
}
