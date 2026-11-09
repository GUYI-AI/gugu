import { messageForUser } from '@/lib/userFacingError';
import { ArrowRight, ChevronRight, Plus } from '@/lib/icons';
import { appsHere } from '@/components/appSlot/appsHere';
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
import type { LibraryMcpProvidedServer, LibraryMcpServer } from '@shared/mcp-library';
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
export const McpLibraryView: React.FC<{ onOpenIntegrations: () => void }> = ({ onOpenIntegrations }) => {
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
        />
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={library.reload} />}
        {library.isLoading ? (
          <PageLoading />
        ) : notice && !library.hasData ? null : (
          <div className="flex flex-col gap-6 py-8">
            <section data-slot="mcp-library-gugu" className="flex flex-col gap-3">
              <h3 className="text-base font-semibold text-foreground">{translate('mcpLibrary.ownGroup')}</h3>
              <FoldGroup slot="mcp-library-builtin" title={translate('mcpLibrary.builtInGroup')} fixed>
                {library.provided?.builtIn.map((name) => (
                  <ProvidedRow key={name} name={name} />
                ))}
              </FoldGroup>
              <FoldGroup
                slot="mcp-library-own"
                title={translate('mcpLibrary.ownServers')}
                count={library.servers.length}
                defaultOpen
                action={{ label: translate('mcpLibrary.add'), onClick: () => void openAdd(), icon: <Plus className="size-3" />, disabled }}
              >
                {library.servers.length === 0 ? (
                  <div data-slot="mcp-library-own-empty" className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="mr-auto text-sm text-foreground-muted">{translate('mcpLibrary.ownEmpty')}</span>
                    <Button variant="ghost" size="sm" data-slot="mcp-library-via-integrations" onClick={onOpenIntegrations}>
                      {translate('mcpLibrary.addViaIntegrations')}
                      <ArrowRight className="size-3" />
                    </Button>
                  </div>
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
              </FoldGroup>
              <ProvidedGroup
                slot="mcp-library-integrations"
                title={translate('mcpLibrary.integrationsGroup')}
                servers={library.provided?.servers.filter((server) => server.group === 'integrations') ?? []}
                action={{ label: translate('mcpLibrary.manageIntegrations'), onClick: onOpenIntegrations }}
                library={library}
                onFail={fail}
              />
              <ProvidedGroup
                slot="mcp-library-apps"
                title={translate('mcpLibrary.appsGroup')}
                servers={library.provided?.servers.filter((server) => server.group === 'apps') ?? []}
                {...(appsHere ? { action: { label: translate('mcpLibrary.manageApps'), onClick: () => appsHere!.openAppsPage() } } : {})}
                library={library}
                onFail={fail}
              />
            </section>
            {library.installed.length > 0 && (
              <section data-slot="mcp-library-harnesses" className="flex flex-col gap-3">
                <h3 className="text-sm font-medium text-foreground-muted">{translate('mcpLibrary.harnessesGroup')}</h3>
            {library.installed.map((agent) => (
              <HarnessGroup key={agent.id} agent={agent} library={library} disabled={disabled} onFail={fail} />
            ))}
              </section>
            )}
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
    <FoldGroup
      slot="mcp-library-harness"
      providerId={agent.id}
      icon={<AgentIcon id={agent.id} size={20} className="shrink-0 rounded-sm" />}
      // @@@raw agent name — harness 名是 provider 数据,原样显示。
      title={agent.name}
      open={open}
      onOpenChange={setOpen}
    >
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
    </FoldGroup>
  );
}

/**
 * MCP 页上每一组的外壳:段头(箭头 + 可选图标 + 标题 + 台数 + 可选的「去管理」)和卡片。默认折叠,`defaultOpen` 的除外;
 * 受控用法(`open` / `onOpenChange`)给展开才读的那几组。
 */
function FoldGroup({
  slot,
  providerId,
  icon,
  title,
  count,
  action,
  defaultOpen,
  fixed,
  open,
  onOpenChange,
  children,
}: {
  slot: string;
  providerId?: string;
  icon?: React.ReactNode;
  title: string;
  count?: number;
  action?: { label: string; onClick: () => void; icon?: React.ReactNode; disabled?: boolean };
  defaultOpen?: boolean;
  /** 只有一两行、不值得折叠的组(内置):常开,没有箭头。 */
  fixed?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      data-slot={slot}
      {...(providerId ? { 'data-provider-id': providerId } : {})}
      {...(fixed ? { open: true } : open === undefined ? { defaultOpen: !!defaultOpen } : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      className="flex flex-col gap-2"
    >
      <div className="flex min-h-7 items-center gap-2">
        {fixed ? (
          <span className="truncate text-sm text-foreground">{title}</span>
        ) : (
          <CollapsibleTrigger className="group/trigger flex min-w-0 items-center gap-2 rounded-md text-left">
            <ChevronRight className="size-4 shrink-0 text-foreground-muted transition-transform group-data-[panel-open]/trigger:rotate-90" />
            {icon}
            <span className="truncate text-sm text-foreground">{title}</span>
            {count ? <span className="shrink-0 text-xs text-foreground-muted">{count}</span> : null}
          </CollapsibleTrigger>
        )}
        {action && (
          <Button variant="ghost" size="xs" className="ml-auto text-foreground-muted" onClick={action.onClick} disabled={action.disabled}>
            {action.icon}
            {action.label}
            {!action.icon && <ArrowRight className="size-3" />}
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <div className={CARD}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 内置那一台:只有名字 —— 「内置」这个组名已经说了它每个任务都带。 */
function ProvidedRow({ name }: { name: string }) {
  return (
    <div data-slot="mcp-library-provided" data-server-id={name} className="flex min-h-12 items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={name}>{name}</span>
    </div>
  );
}

/**
 * 集成、App 递给 agent 的那几台(只读),和「我加的」同一种行。展开这一组时才去取各台的工具列表 —— 列 App 的工具会把程序起起来。
 */
function ProvidedGroup({
  slot,
  title,
  servers,
  action,
  library,
  onFail,
}: {
  slot: string;
  title: string;
  servers: readonly LibraryMcpProvidedServer[];
  action?: { label: string; onClick: () => void };
  library: ReturnType<typeof useMcpLibrary>;
  onFail: (failure: unknown) => void;
}) {
  const { translate } = useSessionMessages();
  if (servers.length === 0) return null;
  const loadTools = (open: boolean) => {
    if (!open) return;
    for (const server of servers) {
      if (!library.providedChecks[server.key] && !library.checking.has(server.key)) void library.checkProvided(server.key).catch(onFail);
    }
  };
  return (
    <FoldGroup slot={slot} title={title} count={servers.length} {...(action ? { action } : {})} onOpenChange={loadTools}>
      {servers.map((server) => (
        <McpLibraryRow
          key={server.key}
          // @@@raw provided server — 名字、命令是递送时的那份描述,来源是集成 / App 的名字,原样显示。
          server={server}
          check={library.providedChecks[server.key]}
          checking={library.checking.has(server.key)}
          disabled={false}
          note={`${server.from.join('、')} · ${translate(`mcpLibrary.reach.${server.reach}`)}`}
          {...(server.refusal ? { noteTitle: server.refusal } : {})}
          onCheck={() => void library.checkProvided(server.key).catch(onFail)}
        />
      ))}
    </FoldGroup>
  );
}
