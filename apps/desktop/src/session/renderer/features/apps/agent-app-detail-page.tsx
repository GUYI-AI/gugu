import { Share2 } from '@/lib/icons';
import { openForward } from '@/components/chat/forwardToChats';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { rpc } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { useManagementAgent } from '@renderer/lib/stores/use-agents';
import { managementAgent } from '@renderer/lib/stores/agent-replicas';
import { refreshFailure } from '@/lib/replica';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { agentMarketCategoryOf } from '@shared/extensions/catalog';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { AppProductBack, AppProductHeader } from '../extensions/panel/app-product-header';
import { marketAgentDescription } from '../extensions/panel/market-agent-description';
import { useLibraryHost } from '../library/library-host';
import { deviceScopeNotice } from '../remote-hosts/device-scope-notice';
import { DeviceScopeNoticeLine } from '../remote-hosts/device-scope-picker';
import { agentOffersConnections } from '../settings/agents-page/agent-account';
import { InstallSection, type AgentInstallationHeader } from '../settings/agents-page/InstallSection';
import { useConnectionStatus } from '../settings/subscriptions/connection-status';

const SOURCE_LABELS = {
  local: 'agentsPage.sourceLocal',
  managed: 'agentsPage.sourceManaged',
  custom: 'agentsPage.sourceCustom',
} as const;

export function AgentAppDetailPage({ agentId, backLabel, onBack, onCreate }: {
  agentId: string;
  backLabel: string;
  onBack: () => void;
  onCreate: () => void;
}) {
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const reading = useManagementAgent(agentId);
  const agent = reading.state === 'value' ? reading.value : undefined;
  const retry = () => void managementAgent.refresh(host.remote?.deviceId ?? null, agentId);
  const notice = deviceScopeNotice({
    remote: host.remote,
    error: refreshFailure(reading),
    hasData: !!agent,
    now: Date.now(),
  }, translate);
  const readOnly = host.remote?.online === false || !!notice?.readOnly;
  return (
    <div className="mk py-10" data-testid="agent-app-detail" data-agent-id={agentId}>
      <AppProductBack label={backLabel} onBack={onBack} testId="agent-app-detail-back" />
      {notice && <DeviceScopeNoticeLine notice={{ ...notice, inHeading: false }} onRetry={retry} />}
      {agent ? (
        <fieldset disabled={readOnly} className="contents">
          <InstallSection
            agentId={agentId}
            agentPayload={agent}
            installOptions={agent.installOptions}
            installDocs={agent.installDocs}
            renderPage={(installation, settings) => (
              <>
                <AgentDetailHeader agent={agent} installation={installation} onCreate={onCreate} readOnly={readOnly} />
                <div className="mk-agent-settings">{settings}</div>
              </>
            )}
          />
        </fieldset>
      ) : !notice && (
        reading.state === 'error' || agent === null ? (
          <div className="mk-status" role="status">
            {translate(reading.state === 'error' ? 'agentsPage.detailLoadFailed' : 'agentsPage.detailUnavailable')}
          </div>
        ) : <PageLoading />
      )}
    </div>
  );
}

function AgentDetailHeader({ agent, installation, onCreate, readOnly }: {
  agent: AgentPayload;
  installation: AgentInstallationHeader;
  onCreate: () => void;
  readOnly: boolean;
}) {
  const { translate, locale } = useSessionMessages();
  const { version, source, install, installed, installing, runnable, busy } = installation;
  const forward = async () => {
    try {
      // A forwarded agent opens on the reader's device, independently of the sender's selected device.
      const url = await rpc.extensions.resourceLink({ kind: 'agent-app-detail', agentId: agent.id });
      openForward([{ kind: 'text', sender: null, text: url }]);
    } catch {
      toast({ title: translate('agentsPage.detailForwardFailed'), variant: 'destructive' });
    }
  };
  const installDocs = agent.installDocs;
  return (
    <header className="mk-dh">
      <AppProductHeader
        name={agent.name}
        subtitle={marketAgentDescription(agent, locale)}
        publisher={agent.publisher}
        facts={[
          { caption: translate('extensions.stripVersion'), value: version ? `v${version.replace(/^v/, '')}` : '—' },
          { caption: translate('agentsPage.sourceHeading'), value: source ? translate(SOURCE_LABELS[source]) : '—' },
          { caption: translate('agentsPage.detailConnection'), value: installed && agentOffersConnections(agent) ? <AgentConnectionFact agent={agent} /> : '—' },
          { caption: translate('extensions.infoCategory'), value: translate(agentMarketCategoryOf(agent.id) === 'general' ? 'agentsPage.detailGeneral' : 'agentsPage.detailCoding') },
        ]}
        icon={<AppIcon id={agent.id} size={112} dimmed={!installed} />}
      >
        <div className="mk-acts" aria-busy={busy || undefined}>
          {installed ? (
            <Button size="lg" className="min-w-48" disabled={readOnly || busy || !runnable} onClick={onCreate} data-testid="agent-app-detail-create">
              {translate('sidebar.createAgent')}
            </Button>
          ) : install ? (
            <Button size="lg" className="min-w-48" disabled={readOnly || busy} onClick={install} data-testid="agent-app-detail-install">
              {translate(installing ? 'agentsPage.installingToGuguHome' : 'agentsPage.installWithManaged')}
            </Button>
          ) : installDocs ? (
            <Button size="lg" className="min-w-48" disabled={readOnly} onClick={() => confirmOpenExternalLink(installDocs)}>
              {translate('agentsPage.installDocsLink')}
            </Button>
          ) : null}
          <Button size="lg" variant="ghost" disabled={readOnly} onClick={() => void forward()}>
            <Share2 className="size-4" />
            {translate('extensions.forward')}
          </Button>
        </div>
      </AppProductHeader>
    </header>
  );
}

function AgentConnectionFact({ agent }: { agent: AgentPayload }) {
  const { remote } = useLibraryHost();
  const { badge, currentConnection } = useConnectionStatus(remote?.deviceId ?? null, agent);
  return badge || currentConnection?.name || '—';
}
