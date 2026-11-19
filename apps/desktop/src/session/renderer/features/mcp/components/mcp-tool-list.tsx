import React from 'react';
import { ChevronRight } from '@/lib/icons';
import { mono } from '@renderer/lib/ui/assistant-ui/surfaces';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { LibraryMcpTool } from '@shared/mcp-library';

type Property = {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: { type?: unknown };
  anyOf?: Property[];
};

/** 参数的类型写成一个短词:`string`、`string[]`、枚举写出取值(`a|b`)。 */
function typeOf(property: Property): string {
  if (Array.isArray(property.enum)) return property.enum.join('|');
  if (Array.isArray(property.anyOf)) return property.anyOf.map(typeOf).join('|');
  const type = Array.isArray(property.type) ? property.type.join('|') : typeof property.type === 'string' ? property.type : '';
  return type === 'array' && typeof property.items?.type === 'string' ? `${property.items.type}[]` : type;
}

/** 一个工具展开后的参数:名字、类型、必填,说明一行。只列顶层(嵌套的对象写成 object)。 */
function ToolParameters({ schema }: { schema: Record<string, unknown> }) {
  const { translate } = useSessionMessages();
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(properties);
  if (names.length === 0) return null;
  return (
    <div data-slot="mcp-tool-params" className="flex flex-col gap-1 pt-1">
      {names.map((name) => (
        <div key={name} className="flex min-w-0 items-baseline gap-2 text-xs">
          {/* @@@raw tool schema — server 报回来的参数名、类型、说明,原样显示。 */}
          <span className={cn(mono, 'shrink-0 text-foreground')}>{name}</span>
          <span className={cn(mono, 'shrink-0 text-foreground-muted')}>{typeOf(properties[name]!)}</span>
          {required.has(name) && <span className="shrink-0 text-foreground-muted">{translate('mcpLibrary.required')}</span>}
          {typeof properties[name]!.description === 'string' && (
            <span className="min-w-0 truncate text-foreground-passive" title={properties[name]!.description as string}>
              {properties[name]!.description as string}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** 一个工具:名字和说明的头一行;有参数或说明不止一行时可展开,看全文和参数。 */
function ToolRow({ tool }: { tool: LibraryMcpTool }) {
  const params = Object.keys((tool.inputSchema?.properties ?? {}) as object).length > 0;
  const head = (
    <>
      <span className={cn(mono, 'shrink-0 text-xs text-foreground')}>{tool.name}</span>
      {tool.description && (
        <span className="min-w-0 truncate text-xs text-foreground-muted group-data-[panel-open]/tool:hidden">{tool.description}</span>
      )}
    </>
  );
  if (!params && !tool.description) {
    return (
      <div data-slot="mcp-tool" data-tool={tool.name} className="flex min-h-7 items-baseline gap-2 py-1 pl-6">
        {head}
      </div>
    );
  }
  return (
    <Collapsible data-slot="mcp-tool" data-tool={tool.name}>
      <CollapsibleTrigger className="group/tool flex min-h-7 w-full min-w-0 items-baseline gap-2 rounded-md py-1 text-left">
        <ChevronRight className="size-3 shrink-0 self-center text-foreground-passive transition-transform group-data-[panel-open]/tool:rotate-90" />
        {head}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 pb-2 pl-5">
        {tool.description && <p className="whitespace-pre-wrap text-xs text-foreground-muted">{tool.description}</p>}
        {tool.inputSchema && <ToolParameters schema={tool.inputSchema} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 一台 server 报回来的工具,按它给的顺序。 */
export function McpToolList({ tools }: { tools: readonly LibraryMcpTool[] }) {
  return (
    <div data-slot="mcp-tool-list" className="flex flex-col">
      {tools.map((tool) => (
        <ToolRow key={tool.name} tool={tool} />
      ))}
    </div>
  );
}
