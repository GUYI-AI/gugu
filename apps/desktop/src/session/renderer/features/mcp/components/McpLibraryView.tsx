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
import { SectionLabel } from '@/components/ui/SectionLabel';
import { GuguToolGroups } from './gugu-tool-groups';
import { McpLibraryRow } from './mcp-library-row';
import { useHarnessMcpServers, useMcpLibrary } from './use-mcp-library';
import type { AgentPayload } from '@shared/core/agents/agent-payload';

/**
 * 整页一种行(owner 11-10「层级关系视觉上很乱, 有很多奇怪的框啊缩进啊」):无框、无分隔线,左边对齐,展开箭头同一列;
 * 一组展开后的那几行缩进一个箭头宽,箭头对齐组名。
 */
const NESTED = 'flex flex-col pl-6';
/** 空、读取中:一行灰字,和行里的名字对齐。 */
const QUIET = 'py-2 pl-6 text-sm text-foreground-muted';

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
            <section data-slot="mcp-library-gugu" className="flex flex-col">
              <SectionLabel className="!px-0">{translate('mcpLibrary.ownGroup')}</SectionLabel>
              {library.provided?.builtIn.map((name) => (
                <BuiltInRow key={name} name={name} library={library} disabled={disabled} onFail={fail} />
              ))}
              <ProvidedGroup
                slot="mcp-library-integrations"
                title={translate('mcpLibrary.integrationsGroup')}
                servers={library.provided?.servers.filter((server) => server.group === 'integrations') ?? []}
                action={{
                  label: translate('mcpLibrary.manageIntegrations'),
                  onClick: onOpenIntegrations,
                }}
                keepEmpty
                library={library}
                onFail={fail}
              />
              <ProvidedGroup
                slot="mcp-library-apps"
                title={translate('mcpLibrary.appsGroup')}
                servers={library.provided?.servers.filter((server) => server.group === 'apps') ?? []}
                {...(appsHere
                  ? {
                      action: {
                        label: translate('mcpLibrary.manageApps'),
                        onClick: () => appsHere!.openAppsPage(),
                      },
                    }
                  : {})}
                library={library}
                onFail={fail}
              />
            </section>
            <section data-slot="mcp-library-own" className="flex flex-col">
              <SectionLabel
                className="!px-0"
                trailing={
                  <Button variant="ghost" size="xs" className="text-foreground-muted" onClick={() => void openAdd()} disabled={disabled}>
                    <Plus className="size-3" />
                    {translate('mcpLibrary.add')}
                  </Button>
                }
              >
                {translate('mcpLibrary.ownServers')}
              </SectionLabel>
              {library.servers.length === 0 ? (
                <div data-slot="mcp-library-own-empty" className={QUIET}>
                  {translate('mcpLibrary.ownEmpty')}
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
            </section>
            {library.installed.length > 0 && (
              <section data-slot="mcp-library-harnesses" className="flex flex-col">
                <SectionLabel className="!px-0">{translate('mcpLibrary.harnessesGroup')}</SectionLabel>
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
        <div className={QUIET}>{translate('mcpLibrary.harnessReading')}</div>
      ) : servers.error ? (
        <div data-slot="mcp-library-harness-error" className="flex items-center gap-3 py-2 pl-6">
          <span className="min-w-0 flex-1 text-sm text-foreground-destructive">
            {translate('mcpLibrary.harnessReadFailed', { agent: agent.name })}
          </span>
          <Button variant="outline" size="sm" onClick={() => void servers.refetch()}>
            {translate('common.retry')}
          </Button>
        </div>
      ) : (servers.data ?? []).length === 0 ? (
        <div className={QUIET}>{translate('mcpLibrary.harnessEmpty', { agent: agent.name })}</div>
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
 * MCP 页上每一组:段头(箭头 + 可选图标 + 标题 + 台数 + 可选的「去管理」)和展开后缩进一格的那几行。默认折叠;
 * 受控用法(`open` / `onOpenChange`)给展开才读的那几组。
 */
function FoldGroup({
  slot,
  providerId,
  icon,
  title,
  count,
  action,
  open,
  onOpenChange,
  children,
}: {
  slot: string;
  providerId?: string;
  icon?: React.ReactNode;
  title: string;
  count?: number;
  /** `count` 为 0 的组只剩段头(和它的「去管理」)。 */
  action?: { label: string; onClick: () => void };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible
      data-slot={slot}
      {...(providerId ? { 'data-provider-id': providerId } : {})}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      className="flex flex-col"
    >
      <div className="flex min-h-10 items-center gap-2">
        {count === 0 ? (
          // 没有可展开的:箭头的位置空着,标题和能展开的那几组对齐。
          <span className="flex min-w-0 items-center gap-2">
            <span className="size-4 shrink-0" />
            <span className="truncate text-sm text-foreground">{title}</span>
          </span>
        ) : (
          <CollapsibleTrigger className="group/trigger flex min-w-0 items-center gap-2 rounded-md text-left">
            <ChevronRight className="size-4 shrink-0 text-foreground-muted transition-transform group-data-[panel-open]/trigger:rotate-90" />
            {icon}
            <span className="truncate text-sm text-foreground">{title}</span>
            {count ? <span className="shrink-0 text-xs text-foreground-muted">{count}</span> : null}
          </CollapsibleTrigger>
        )}
        {action && (
          <Button variant="ghost" size="xs" className="ml-auto text-foreground-muted" onClick={action.onClick}>
            {action.label}
            <ArrowRight className="size-3" />
          </Button>
        )}
      </div>
      {count !== 0 && (
        <CollapsibleContent>
          <div className={NESTED}>{children}</div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

/**
 * 内置那一台(咕咕自己):和别的 server 同一种行,展开时向宿主取它此刻组装出来的那台的工具,按组列出、每组一个开关。
 * 没有「检测」—— 它就是宿主自己,工具列表就是读数。
 */
function BuiltInRow({
  name,
  library,
  disabled,
  onFail,
}: {
  name: string;
  library: ReturnType<typeof useMcpLibrary>;
  disabled: boolean;
  onFail: (failure: unknown) => void;
}) {
  const { translate } = useSessionMessages();
  const check = library.providedChecks[name];
  const load = () => void library.checkProvided(name).catch(onFail);
  // 进页就取(进程内组装一台、不连不跑),行上直接有工具数。
  React.useEffect(load, []);
  return (
    <McpLibraryRow
      server={{ name }}
      check={check}
      checking={library.checking.has(name)}
      disabled={disabled}
      details={
        check ? (
          <GuguToolGroups
            tools={check.tools}
            off={library.provided?.guguToolsOff}
            disabled={disabled}
            onChange={(off) => void library.setGuguToolsOff(off).catch(onFail)}
          />
        ) : library.checking.has(name) ? (
          <div className={QUIET}>{translate('mcpLibrary.harnessReading')}</div>
        ) : (
          <div className="pb-2 pl-6">
            <Button variant="outline" size="sm" onClick={load}>
              {translate('common.retry')}
            </Button>
          </div>
        )
      }
    />
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
  keepEmpty,
  library,
  onFail,
}: {
  slot: string;
  title: string;
  servers: readonly LibraryMcpProvidedServer[];
  /** 没连任何集成时也留着段头:「去集成页」是从 MCP 页加集成的那条路。 */
  keepEmpty?: boolean;
  action?: { label: string; onClick: () => void };
  library: ReturnType<typeof useMcpLibrary>;
  onFail: (failure: unknown) => void;
}) {
  const { translate } = useSessionMessages();
  if (servers.length === 0 && !keepEmpty) return null;
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
