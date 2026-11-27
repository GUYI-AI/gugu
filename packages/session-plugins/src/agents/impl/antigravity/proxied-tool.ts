import type { NormalizedEvent } from '@gugu/session-core/acp';
import type { AcpClientFactory } from '@gugu/session-core/agents/plugins';
import { antigravityServerName } from './session-bundle';

/** `agy` calls every lazily loaded MCP tool through this one tool of its own. */
const PROXY_TOOL = 'call_mcp_tool';

type ToolEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' }>;

/**
 * The call's own identity, where `agy` reports it as `call_mcp_tool` with `rawInput {ServerName, ToolName, Arguments}`
 * (1.5.3 / 1.5.18; an `execute` call titled `MCP Tool <ToolName>`): `mcp__<server>__<tool>` with the tool's own
 * arguments, which is how every other part of Gugu knows an MCP call and draws its cards for sent messages and files.
 * The servers Gugu hosts are renamed on this leg (see `acpRelayName`) and read back under their own names; every other
 * server keeps the name the call targeted. Anything not shaped like that stays as it came.
 */
function withIdentity<Event extends ToolEvent>(event: Event): Event {
  if (event.toolName !== PROXY_TOOL || typeof event.rawInput !== 'string') return event;
  let input: { ServerName?: unknown; ToolName?: unknown; Arguments?: unknown } | null;
  try {
    input = JSON.parse(event.rawInput) as typeof input;
  } catch {
    return event;
  }
  const server = input?.ServerName;
  const tool = input?.ToolName;
  if (typeof server !== 'string' || typeof tool !== 'string' || !server || !tool || server.includes('__')) return event;
  return { ...event, toolName: `mcp__${antigravityServerName(server)}__${tool}`, rawInput: JSON.stringify(input?.Arguments ?? {}) };
}

/** Live updates, replayed history and approval cards all read the same identity. */
export function withProxiedMcpIdentity(toClient: AcpClientFactory): AcpClientFactory {
  return (agent) => {
    const client = toClient(agent);
    return {
      ...client,
      sessionEvent: (params) => {
        const { event } = params;
        client.sessionEvent(event.kind === 'tool_call' || event.kind === 'tool_update'
          ? { ...params, event: withIdentity(event) }
          : params);
      },
      requestPermission: (params) => client.requestPermission(
        params.toolCall ? { ...params, toolCall: withIdentity(params.toolCall) } : params
      ),
    };
  };
}
