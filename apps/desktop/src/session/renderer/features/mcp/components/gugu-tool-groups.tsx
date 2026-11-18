import React from 'react';
import { ChevronRight } from '@/lib/icons';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { GUGU_TOOL_GROUPS, guguToolGroupOf, type GuguToolsOff } from '@shared/gugu-tool-groups';
import type { LibraryMcpTool } from '@shared/mcp-library';
import { McpToolList } from './mcp-tool-list';

/**
 * 内置那台展开后:按组列它的工具,每组一个开关(关掉的组所有 agent 新开的会话都拿不到)。锁住的组开关常开、点不动。
 * `off` 缺 = 那台机器的咕咕还不认这份开关(旧版本),只列不改。
 */
export function GuguToolGroups({
  tools,
  off,
  disabled,
  onChange,
}: {
  tools: readonly LibraryMcpTool[];
  off: GuguToolsOff | undefined;
  disabled: boolean;
  onChange: (off: GuguToolsOff) => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div data-slot="gugu-tool-groups" className="flex flex-col pb-2">
      {GUGU_TOOL_GROUPS.map((group) => {
        const members = tools.filter((tool) => guguToolGroupOf(tool.name) === group.id);
        if (members.length === 0) return null;
        const label = translate(`mcpLibrary.toolGroup.${group.id}`);
        const on = group.locked || !off?.includes(group.id as GuguToolsOff[number]);
        return (
          <Collapsible key={group.id} data-slot="gugu-tool-group" data-group={group.id} data-on={on}>
            <div className="flex min-h-9 items-center gap-2 pl-6">
              <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 items-center gap-2 rounded-md text-left">
                <ChevronRight className="size-4 shrink-0 text-foreground-muted transition-transform group-data-[panel-open]/trigger:rotate-90" />
                <span className={on ? 'truncate text-sm text-foreground' : 'truncate text-sm text-foreground-muted'}>{label}</span>
                <span className="shrink-0 text-xs text-foreground-muted">{members.length}</span>
              </CollapsibleTrigger>
              <Switch
                size="sm"
                checked={on}
                disabled={group.locked || disabled || !off}
                aria-label={label}
                onCheckedChange={(checked) =>
                  off && onChange(checked ? off.filter((id) => id !== group.id) : [...off, group.id as GuguToolsOff[number]])
                }
              />
            </div>
            <CollapsibleContent className="pl-12">
              <McpToolList tools={members} />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
