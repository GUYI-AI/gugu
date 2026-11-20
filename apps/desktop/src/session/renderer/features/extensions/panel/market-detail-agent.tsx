import type { ReactNode } from 'react';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { useManagementAgent } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { agentMarketCategoryOf } from '@shared/extensions/catalog';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { InstallSection, type AgentInstallationHeader } from '@renderer/features/settings/agents-page/InstallSection';
import { useAgentUninstallConfirmation } from '@renderer/features/settings/agents-page/agent-uninstall-confirmation';
import { SettingsGroup } from '@/components/settings/SettingsPrimitives';
import { AgentHomeRow } from '@renderer/features/settings/subscriptions/AgentHomeRow';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { MarketDetailCard } from './market-detail-dialog';
import { MarketAgentDevices } from './market-detail-agent-devices';
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
  const host = useLibraryHost();
  const notice = deviceScopeNotice({ remote: host.remote, error: query.error, hasData: !!query.data, now: Date.now() }, translate);
  const readOnly = host.remote?.online === false || !!notice?.readOnly;
  const noticeLine = notice && <DeviceScopeNoticeLine notice={{ ...notice, inHeading: false }} onRetry={() => void query.refetch()} />;
  if (!query.data) {
    return (
      <><DialogHeader>
        <DialogTitle role="status">{translate(
          query.isPending ? 'extensions.loading' : query.isError ? 'agentsPage.detailLoadFailed' : 'agentsPage.detailUnavailable'
        )}</DialogTitle>
      </DialogHeader>{noticeLine}</>
    );
  }
  const agent = query.data;
  return (
    <fieldset disabled={readOnly} className="contents" data-read-only={readOnly || undefined}><InstallSection
      manageOldVersions
      agentId={agentId}
      agentPayload={agent}
      installOptions={agent.installOptions}
      renderPage={(installation) => <AgentCard agent={agent} installation={installation} onCreate={onCreate} notice={noticeLine} readOnly={readOnly} />}
    /></fieldset>
  );
}

function AgentCard({ agent, installation, onCreate, notice, readOnly }: {
  agent: AgentPayload;
  installation: AgentInstallationHeader;
  onCreate: () => void;
  notice: ReactNode;
  readOnly: boolean;
}) {
  const { translate, locale } = useSessionMessages();
  const host = useLibraryHost();
  const { confirmation, requestUninstall } = useAgentUninstallConfirmation();
  const { installed, runnable, install, update, uninstall, busy, installing, updating, uninstalling, version, source } = installation;
  const terminalConfiguration = agent.id === 'claude' || agent.id === 'codex';

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
    <>
      <MarketDetailCard
        name={agent.name}
        publisher={agent.publisher ? translate('marketDetail.agentPublisher', { publisher: agent.publisher }) : undefined}
        icon={<AppIcon id={agent.id} size={68} dimmed={!installed} />}
        actions={actions}
        devices={<MarketAgentDevices agentId={agent.id} />}
        facts={[
          { label: translate('extensions.stripVersion'), value: agentVersion(version) ?? '—' },
          { label: translate('agentsPage.sourceHeading'), value: source ? translate(SOURCE_LABELS[source]) : '—' },
          { label: translate('extensions.infoCategory'), value: translate(agentMarketCategoryOf(agent.id) === 'general' ? 'agentsPage.detailGeneral' : 'agentsPage.detailCoding') },
        ]}
        subtitle={marketAgentDescription(agent, locale)}
        notice={notice}
        onUninstall={uninstall && !busy ? () => requestUninstall(agent.name, uninstall) : undefined}
      >
        {installed && (terminalConfiguration || installation.managedVersions) && <SettingsGroup>
          {terminalConfiguration && <AgentHomeRow providerId={agent.id} machine={host.remote?.deviceId ?? null} disabled={readOnly || busy} />}
          {installation.managedVersions}
        </SettingsGroup>}
      </MarketDetailCard>
      {confirmation}
    </>
  );
}
