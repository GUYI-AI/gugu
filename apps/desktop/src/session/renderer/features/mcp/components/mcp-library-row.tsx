import { AlertTriangle, CheckCircle2, ChevronRight, Globe, Info, Pencil, Refresh, Terminal, Trash2, XCircle } from '@/lib/icons';
import React from 'react';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { field, mono } from '@renderer/lib/ui/assistant-ui/surfaces';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { LibraryMcpCheck, LibraryMcpServer } from '@shared/mcp-library';
import { McpToolList } from './mcp-tool-list';

/** 咕咕递的集成、App 那几台未必说得出传输方式(原生程序没有命令),所以这里 `transport` 可缺。 */
type RowServer = Omit<LibraryMcpServer, 'enabledByDefault' | 'check' | 'transport'> & { transport?: LibraryMcpServer['transport'] };

/** 命令行或 URL,给人看:stdio 拼回一行,http 去掉查询串(可能带凭据)。 */
function targetOf(server: RowServer): string {
  if (server.transport === 'http') {
    try {
      const url = new URL(server.url ?? '');
      return url.origin + url.pathname;
    } catch {
      return server.url ?? '';
    }
  }
  return [server.command ?? '', ...(server.args ?? [])].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

/**
 * 状态图标 + 弹层(照 AionUi:检测中 / 通过 / 失败 / 需要登录 / 未检测),❌ 身份图标。
 * 弹层写明这是手动检测的读数;各家自己的那几台再加一句:是咕咕照那份配置起的。
 */
function CheckStatus({ check, checking, harnessName }: { check?: LibraryMcpCheck; checking: boolean; harnessName?: string }) {
  const { translate } = useSessionMessages();
  const status = checking ? 'checking' : check?.status ?? 'unchecked';
  const icon = {
    checking: <LoadingIndicator size="inline" className="text-foreground-muted" />,
    ok: <CheckCircle2 className="size-4 text-foreground-success" />,
    failed: <XCircle className="size-4 text-foreground-destructive" />,
    'needs-login': <AlertTriangle className="size-4 text-foreground-warning" />,
    unchecked: <Info className="size-4 text-foreground-passive" />,
  }[status];
  const label = translate(`mcpLibrary.status.${status === 'needs-login' ? 'needsLogin' : status}`);
  return (
    <Popover>
      <PopoverTrigger
        data-slot="mcp-check-status"
        data-status={status}
        aria-label={label}
        className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1 hover:bg-background-2"
      >
        {icon}
        {/* 拿到了工具列表就把数写在明面上;工具本身在行展开里。 */}
        {status === 'ok' && check && (
          <span className="text-xs text-foreground-muted">{translate('mcpLibrary.tools', { count: check.tools.length })}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{label}</span>
          {check && (
            <span className="text-xs text-foreground-muted">
              {translate('mcpLibrary.statusAt', { time: new Date(check.at).toLocaleString() })}
            </span>
          )}
        </div>
        {check?.failure && (
          <div data-slot="mcp-check-failure" className="flex flex-col gap-1">
            <p className="text-xs text-foreground">
              {translate(`mcpLibrary.failure.${check.failure.kind}`, {
                command: check.failure.command ?? '',
                code: String(check.failure.code ?? ''),
                status: String(check.failure.status ?? ''),
              })}
            </p>
            {check.failure.said && (
              // @@@raw server stderr — server 自己在 stderr 上说的最后一行,它自己的话,原样给人看。
              <p className={cn(mono, 'break-words text-xs text-foreground-muted')}>{check.failure.said}</p>
            )}
          </div>
        )}
        {check?.status === 'needs-login' && <p className="text-xs text-foreground-muted">{translate('mcpLibrary.needsLoginNote')}</p>}
        <p className="text-xs text-foreground-passive">
          {harnessName ? translate('mcpLibrary.harnessNote', { agent: harnessName }) : translate('mcpLibrary.manualNote')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 资源库 → MCP 的一行。我加的那几台:默认启用开关、检测、编辑、删除;各家自己的(`harnessName`)和集成、App 递的那几台:
 * 只读,只能检测 —— 编辑、删除、开关只在给了对应回调时出现。`note`:这一台怎么进任务(每个任务都带 / 按需查找)。
 * 拿到了工具列表(检测通过,或给了 `details`)的行可以展开:名字那一段是展开的把手,下面列工具。内置那台没有检测
 * (它就是宿主自己),`details` 是按组的工具和开关,展开时由 `onOpenChange` 去取。
 */
export function McpLibraryRow({
  server,
  check,
  checking,
  disabled,
  harnessName,
  note,
  noteTitle,
  enabledByDefault,
  onCheck,
  onToggleDefault,
  onEdit,
  onDelete,
  details,
  onOpenChange,
}: {
  server: RowServer;
  check?: LibraryMcpCheck;
  checking: boolean;
  disabled: boolean;
  harnessName?: string;
  note?: string;
  noteTitle?: string;
  enabledByDefault?: boolean;
  onCheck?: () => void;
  details?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  onToggleDefault?: (enabled: boolean) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { translate } = useSessionMessages();
  const target = targetOf(server);
  const defaultSwitchId = React.useId();
  const body =
    details ??
    (check?.status === 'ok' && check.tools.length > 0 ? (
      <div className="pb-2 pl-6">
        <McpToolList tools={check.tools} />
      </div>
    ) : null);
  const identity = (
    <>
      {/* @@@raw server identity — 名字与命令行来自用户自己写的配置,原样显示。 */}
      <span data-slot="mcp-server-name" className="max-w-[70%] shrink-0 truncate text-sm text-foreground" title={server.name}>
        {server.name}
      </span>
      <span data-slot="mcp-server-target" className={cn(mono, 'min-w-0 truncate text-foreground-muted')} title={target}>
        {target}
      </span>
    </>
  );
  return (
    <Collapsible
      data-slot="mcp-library-server"
      data-server-id={server.name}
      data-source={harnessName ? 'harness' : onEdit ? 'gugu' : 'provided'}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <div className="group flex min-h-10 items-center gap-3 py-1">
        {/* 名字和命令行排成一行,放不下时省略命令行的尾部;名字不让(哪怕缩 0.1px 也会出省略号),只在超过七成宽时省略。悬停看全文。 */}
        {body ? (
          <CollapsibleTrigger
            data-slot="mcp-server-expand"
            className="group/row flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-left"
          >
            <ChevronRight className="size-4 shrink-0 self-center text-foreground-muted transition-transform group-data-[panel-open]/row:rotate-90" />
            {identity}
          </CollapsibleTrigger>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="size-4 shrink-0" />
            {identity}
          </div>
        )}
        {server.transport && (
          <span className={cn(field, mono, 'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-foreground-muted')}>
            {server.transport === 'http' ? <Globe className="size-3" /> : <Terminal className="size-3" />}
            {server.transport}
          </span>
        )}
        {note && (
          <span className="shrink-0 text-xs text-foreground-muted" {...(noteTitle ? { title: noteTitle } : {})}>
            {note}
          </span>
        )}
        {onEdit && onDelete && (
          <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onEdit}
              disabled={disabled}
              aria-label={translate('mcpLibrary.edit', { name: server.name })}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDelete}
              disabled={disabled}
              aria-label={translate('mcpLibrary.delete', { name: server.name })}
            >
              <Trash2 />
            </Button>
          </div>
        )}
        {onCheck ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onCheck}
              disabled={checking}
              aria-label={translate('mcpLibrary.check')}
              data-slot="mcp-check-run"
            >
              <Refresh />
            </Button>
            <CheckStatus check={check} checking={checking} harnessName={harnessName} />
          </>
        ) : checking ? (
          <LoadingIndicator size="inline" className="text-foreground-muted" />
        ) : (
          check && (
            <span className="shrink-0 text-xs text-foreground-muted">{translate('mcpLibrary.tools', { count: check.tools.length })}</span>
          )
        )}
        {/* 新任务带不带这一台,只由这个开关决定 —— 所以它的意思写在明面上,❌ 只放在悬停里。 */}
        {onToggleDefault && (
          <span className="inline-flex shrink-0 items-center gap-2">
            <label htmlFor={defaultSwitchId} className="text-xs text-foreground-muted">
              {translate('mcpLibrary.enabledByDefault')}
            </label>
            <Switch
              id={defaultSwitchId}
              size="sm"
              checked={!!enabledByDefault}
              onCheckedChange={(checked) => onToggleDefault(checked)}
              disabled={disabled}
              aria-label={translate('mcpLibrary.enabledByDefault')}
            />
          </span>
        )}
      </div>
      {body && <CollapsibleContent>{body}</CollapsibleContent>}
    </Collapsible>
  );
}
