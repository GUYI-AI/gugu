import { decodePermissionRequest, decodeSessionUpdate } from '@gugu/session-core/acp';
import type { AcpPermissionParams } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { withProxiedMcpIdentity } from './proxied-tool';

const ARGS = { chat_id: '230883', text: 'hi' };
// As `agy acp` 1.5.3 reports a lazily loaded call (captured 2026-11-27).
const call = (server: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: 'tool_call', toolCallId: 't', name: 'call_mcp_tool', kind: 'execute', status: 'pending',
  title: 'MCP Tool message_send', rawInput: { Arguments: ARGS, ServerName: server, ToolName: 'message_send' }, ...extra,
});

function seen(update: Record<string, unknown>) {
  const events: unknown[] = [];
  const asked: AcpPermissionParams[] = [];
  const client = withProxiedMcpIdentity(() => ({
    sessionEvent: (params: { event: unknown }) => { events.push(params.event); },
    requestPermission: (params: AcpPermissionParams) => { asked.push(params); return { outcome: { outcome: 'cancelled' } }; },
  }) as never)({} as never);
  client.sessionEvent({ sessionId: 's', event: decodeSessionUpdate(update) });
  if (String(update.sessionUpdate).startsWith('tool_call')) {
    void client.requestPermission(decodePermissionRequest({ sessionId: 's', toolCall: update, options: [] }));
  }
  return { event: events[0] as Record<string, unknown>, permission: asked[0]?.toolCall as unknown as Record<string, unknown> };
}

describe('antigravity proxied MCP calls', () => {
  it.each(['gugu-mcp', 'gugu'])('a call on %s reads as Gugu\'s own tool with its own arguments', (server) => {
    for (const update of [call(server), call(server, { sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'sent (id=msg:1)' })]) {
      const { event, permission } = seen(update);
      for (const one of [event, permission]) {
        expect(one.toolName).toBe('mcp__gugu__message_send');
        expect(JSON.parse(one.rawInput as string)).toEqual(ARGS);
      }
    }
  });

  it('another server keeps the name the call targeted', () => {
    expect(seen(call('browser-use-mcp')).event.toolName).toBe('mcp__browser-use-mcp__message_send');
    expect(seen(call('browser-use-mcp')).permission.toolName).toBe('mcp__browser-use-mcp__message_send');
  });

  it('leaves everything else as it came', () => {
    const command = { sessionUpdate: 'tool_call', toolCallId: 'c', name: 'run_command', kind: 'execute', title: 'ls',
      rawInput: { CommandLine: 'ls', ServerName: 'gugu-mcp', ToolName: 'message_send' } };
    expect(seen(command).event).toEqual(decodeSessionUpdate(command));
    const nameless = call('gugu-mcp', { rawInput: { ToolName: 'message_send' } });
    expect(seen(nameless).event).toEqual(decodeSessionUpdate(nameless));
    const reply = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } };
    expect(seen(reply).event).toEqual(decodeSessionUpdate(reply));
  });
});
