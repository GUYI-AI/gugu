/** Framework-neutral activation of a real tool row. The host may show its already admitted picture. */
export const TOOL_ACTIVATION_EVENT = 'session-tool-activation';
export function liveToolNames(names: readonly string[]): string[] {
  return names.filter(name => /(?:^|__)(?:computer|browser)[-_]use__/.test(name));
}
export function activateToolRow(event: MouseEvent, toolNames: readonly string[] | undefined): void {
  if (!toolNames?.length) return;
  const root = event.currentTarget as HTMLElement;
  const activation = new CustomEvent(TOOL_ACTIVATION_EVENT, { bubbles: true, cancelable: true, detail: { toolNames } });
  if (!root.dispatchEvent(activation)) event.stopPropagation();
}
