import { expect, it } from 'vitest';
import type { ToolNode } from '@gugu/session-core/acp/client';
import { toolActivationNames } from './tool-activation';
const call = (patch: Record<string, unknown>): ToolNode => ({ id: 'call', seq: 1, toolCallId: 'call', status: 'done',
  title: 'Readable provider title', kind: 'unknown-tool-call', name: 'Readable provider title', ...patch } as ToolNode);
it('uses provider tool identity and unwraps a real catalog call rather than matching a readable title', () => {
  expect(toolActivationNames(call({ toolName: 'mcp__gugu__catalog_call', rawInput: JSON.stringify({ tool: 'browser-use__browser_navigate', args: { url: 'https://example.test/' } }) }))).toEqual(['browser-use__browser_navigate']);
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', tool: 'computer-use__click' }))).toEqual(['computer-use__click']);
  expect(toolActivationNames(call({ title: 'Browser Use', toolName: 'Read', rawInput: 'browser-use__click' }))).toEqual([]);
  expect(toolActivationNames(call({ toolName: 'mcp__gugu__catalog_call', rawInput: '{bad' }))).toEqual([]);
  expect(toolActivationNames(call({ title: undefined, toolName: undefined }))).toEqual([]);
});
it('retains the server identity carried by native MCP rows with a short tool name', () => {
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', server: 'computer_use', tool: 'get_window_state', toolName: 'mcp__computer_use__get_window_state' }))).toEqual(['computer_use__get_window_state']);
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', server: 'browser_use', tool: 'browser_snapshot', toolName: 'mcp__browser_use__browser_snapshot' }))).toEqual(['browser_use__browser_snapshot']);
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', server: 'computer_use', tool: 'get_window_state', toolName: undefined }))).toEqual(['computer_use__get_window_state']);
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', server: 'github', tool: 'search', toolName: undefined, title: 'mcp__computer_use__get_window_state' }))).toEqual([]);
  expect(toolActivationNames(call({ kind: 'mcp-tool-call', server: 'gugu', tool: 'catalog_call', toolName: undefined, rawInput: JSON.stringify({ tool: 'computer-use__get_window_state', args: {} }) }))).toEqual(['computer-use__get_window_state']);
});
