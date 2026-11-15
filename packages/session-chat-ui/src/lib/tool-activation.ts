import { catalogCall, toolCallName, type ToolNode } from '@gugu/session-core/acp/client';

/** Framework-neutral activation of a real tool row. The host may show its already admitted picture. */
export const TOOL_ACTIVATION_EVENT = 'session-tool-activation';
export function liveToolNames(names: readonly string[]): string[] {
  return names.filter(name => /(?:^|__)(?:computer|browser)[-_]use__/.test(name));
}
export function toolActivationNames(item: ToolNode): string[] {
  if (item.kind === 'tool-group') return item.children.flatMap(toolActivationNames);
  const declared = item.kind === 'mcp-tool-call'
    ? item.toolName ?? (item.server ? `${item.server}__${item.tool}` : item.tool)
    : toolCallName(item);
  if (typeof declared !== 'string') return [];
  const name = (item.kind === 'mcp-tool-call' && typeof item.tool === 'string' ? item.tool : declared).replace(/^mcp__.+?__/, '');
  return liveToolNames([catalogCall(name, item.rawInput)?.tool ?? declared.replace(/^mcp__/, '')]);
}
export function activateToolRow(event: MouseEvent, toolNames: readonly string[] | undefined): void {
  if (!toolNames?.length) return;
  const root = event.currentTarget as HTMLElement;
  const activation = new CustomEvent(TOOL_ACTIVATION_EVENT, { bubbles: true, cancelable: true, detail: { toolNames } });
  if (!root.dispatchEvent(activation)) event.stopPropagation();
}
