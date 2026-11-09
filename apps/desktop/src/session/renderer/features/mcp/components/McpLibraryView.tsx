import { messageForUser } from '@/lib/userFacingError';
import { ChevronRight, Plus } from '@/lib/icons';
import React from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { PageHeader } from '@renderer/lib/components/page-header';
import { PageLoading } from '@renderer/lib/components/page-layout';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import type { LibraryMcpServer } from '@shared/mcp-library';
import { McpLibraryRow } from './mcp-library-row';
import { useHarnessMcpServers, useMcpLibrary } from './use-mcp-library';
import type { AgentPayload } from '@shared/core/agents/agent-payload';

/** 卡片面与资源库其它格同一套(`border-border bg-background-1`),组与组之间的距离大于组内标题到卡片。 */
const CARD = 'divide-y divide-foreground/10 overflow-hidden rounded-lg border border-border bg-background-1';

/**
 * 资源库 → MCP(owner 10-18「仿照 aionui 的那种管理机制」+「用户全局配置直接和咕咕的共存」):
 * 上面是咕咕自己管的那份列表(加 / 改 / 删 / 默认启用 / 检测),下面按家列各家自己的用户级那几台(只读、可检测)。
 * 新建任务时勾选的只有咕咕的那几台;各家自己的照常由那一家自己带上。
 */
export const McpLibraryView: React.FC = () => {
  const library = useMcpLibrary();
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const showServerModal = useShowModal('mcpServerModal');
  const showConfirm = useShowModal('confirmActionModal');
  const notice = deviceScopeNotice(
    { remote: host.remote, error: library.error, hasData: library.hasData, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );
  const disabled = library.isBusy || !!notice?.readOnly;
  const fail = (failure: unknown) => {
    log.error('library MCP action failed', { error: String(failure) });
    toast({ title: translate('mcpLibrary.saveFailed'), description: messageForUser(failure), variant: 'destructive' });
  };

  const openAdd = async () =>
    showServerModal({
      existing: library.servers,
      harnessNames: await library.harnessNames(),
      onSuccess: (servers) => void library.add(servers.map((server) => ({ ...server, enabledByDefault: true }))).catch(fail),
    });
  const openEdit = async (server: LibraryMcpServer) =>
    showServerModal({
      initial: server,
      existing: library.servers,
      harnessNames: await library.harnessNames(),
      onSuccess: ([edited]) => edited && void library.update({ ...edited, enabledByDefault: server.enabledByDefault }).catch(fail),
    });
  const confirmDelete = (server: LibraryMcpServer) =>
    showConfirm({
      title: translate('mcpLibrary.delete', { name: server.name }),
      description: translate('mcpLibrary.deleteDescription'),
      confirmLabel: translate('mcpLibrary.deleteConfirm'),
      onSuccess: () => void library.remove(server.name).catch(fail),
    });

  return (
    <TooltipProvider delay={150}>
      <div data-slot="mcp-library" className="flex flex-col text-foreground">
        <PageHeader
          sticky
          title={translate('mcpLibrary.title')}
          description={translate('mcpLibrary.subtitle')}
        >
          <div className="flex w-full justify-end gap-2">
            <Button onClick={() => void openAdd()} disabled={disabled} aria-label={translate('mcpLibrary.add')}>
              <Plus className="size-4" />
              <span className="[@container(max-width:520px)]:hidden">{translate('mcpLibrary.add')}</span>
            </Button>
          </div>
        </PageHeader>
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={library.reload} />}
        {library.isLoading ? (
          <PageLoading />
        ) : notice && !library.hasData ? null : (
          <div className="flex flex-col gap-6 py-8">
            <section data-slot="mcp-library-gugu" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{translate('mcpLibrary.ownGroup')}</h3>
              <div className={CARD}>
                {library.servers.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-foreground-muted">{translate('mcpLibrary.ownEmpty')}</div>
                ) : (
                  library.servers.map((server) => (
                    <McpLibraryRow
                      key={server.name}
                      server={server}
                      check={server.check}
                      checking={library.checking.has(`gugu:${server.name}`)}
                      disabled={disabled}
                      enabledByDefault={server.enabledByDefault}
                      onCheck={() => void library.check(server.name).catch(fail)}
                      onToggleDefault={(enabled) => library.setEnabledByDefault(server.name, enabled)}
                      onEdit={() => void openEdit(server)}
                      onDelete={() => confirmDelete(server)}
                    />
                  ))
                )}
              </div>
            </section>
            {library.installed.map((agent) => (
              <HarnessGroup key={agent.id} agent={agent} library={library} disabled={disabled} onFail={fail} />
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
};

/**
 * 一家自己配的那几台:段头默认折叠,展开才读那一家的配置文件(owner 11-09 msg:00f57c99「默认折叠用户自己的 harness 的
 * mcp 配置(这样也就可以 lazy load 了)」)。读到空、读失败都写在这一组里,不影响别的组。
 */
function HarnessGroup({
  agent,
  library,
  disabled,
  onFail,
}: {
  agent: AgentPayload;
  library: ReturnType<typeof useMcpLibrary>;
  disabled: boolean;
  onFail: (failure: unknown) => void;
}) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = React.useState(false);
  const servers = useHarnessMcpServers(agent.id, open);
  React.useEffect(() => {
    // 原因进日志;界面上只说读不了哪一家、给重试。
    if (servers.error) log.error('agent MCP config read failed', { agentId: agent.id, error: String(servers.error) });
  }, [agent.id, servers.error]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <section data-slot="mcp-library-harness" data-provider-id={agent.id} className="flex flex-col gap-2">
        <CollapsibleTrigger className="group/trigger flex min-h-7 items-center gap-2 self-start rounded-md text-left">
          <ChevronRight className="size-4 shrink-0 text-foreground-muted transition-transform group-data-[panel-open]/trigger:rotate-90" />
          <AgentIcon id={agent.id} size={20} className="shrink-0 rounded-sm" />
          {/* @@@raw agent name — harness 名是 provider 数据,原样显示。 */}
          <h3 className="text-sm font-medium text-foreground">{translate('mcpLibrary.harnessGroup', { agent: agent.name })}</h3>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className={CARD}>
            {servers.isLoading ? (
              <div className="px-3 py-3 text-sm text-foreground-muted">{translate('mcpLibrary.harnessReading')}</div>
            ) : servers.error ? (
              <div data-slot="mcp-library-harness-error" className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 text-sm text-foreground-destructive">
                  {translate('mcpLibrary.harnessReadFailed', { agent: agent.name })}
                </span>
                <Button variant="outline" size="sm" onClick={() => void servers.refetch()}>
                  {translate('common.retry')}
                </Button>
              </div>
            ) : (servers.data ?? []).length === 0 ? (
              <div className="px-3 py-3 text-sm text-foreground-muted">{translate('mcpLibrary.harnessEmpty', { agent: agent.name })}</div>
            ) : (
              (servers.data ?? []).map((server) => (
                <McpLibraryRow
                  key={server.name}
                  server={server}
                  check={library.harnessChecks[`${agent.id}:${server.name}`]}
                  checking={library.checking.has(`${agent.id}:${server.name}`)}
                  disabled={disabled}
                  harnessName={agent.name}
                  onCheck={() => void library.checkHarness(agent.id, server.name).catch(onFail)}
                />
              ))
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
