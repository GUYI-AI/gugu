import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { ANTIGRAVITY_GUGU_SERVERS } from './session-bundle';

/**
 * Gugu's own tools need no approval: Antigravity asks for every MCP call outside its full-access mode, and neither of
 * its ACP servers takes an approved list up front. Both name the target in structured fields, never in the title alone:
 *  · `agy acp` (1.5.16) — the lazily loaded call: `rawInput` is exactly `{ServerName, ToolName, Arguments}`, `kind`
 *    `execute`, titled `MCP Tool <ToolName>`;
 *  · `agy_acp_server` (1.4.5) — `_meta: {is_mcp_tool_call: true, mcp: {server, tool}}`.
 * Gugu's server is `gugu-mcp` on `agy acp`, and `gugu` on the legacy server and in the entry a conversation opened before
 * the rename restores — exact names, ❌ never a suffix: `browser-use-mcp` is another server. Everything else — other MCP
 * servers (Gugu's other ones included), commands, file edits — still asks. The request names the server only, so a user's
 * own `gugu` entry in the managed MCP config would pass too (the same limit as Kiro's).
 */
export function preApproveGuguTool(request: RequestPermissionRequest): string | undefined {
  if (!isAgyGuguCall(request.toolCall) && !isLegacyGuguCall(request.toolCall)) return undefined;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId;
}

const PROXY_FIELDS: ReadonlySet<string> = new Set(['ServerName', 'ToolName', 'Arguments']);

function isAgyGuguCall({ kind, title, rawInput }: RequestPermissionRequest['toolCall']): boolean {
  if (kind !== 'execute' || !rawInput || typeof rawInput !== 'object') return false;
  const input = rawInput as Record<string, unknown>;
  return Object.keys(input).every((key) => PROXY_FIELDS.has(key))
    && ANTIGRAVITY_GUGU_SERVERS.includes(input.ServerName as string)
    && typeof input.ToolName === 'string'
    && title === `MCP Tool ${input.ToolName}`;
}

function isLegacyGuguCall({ _meta }: RequestPermissionRequest['toolCall']): boolean {
  const meta = _meta as { is_mcp_tool_call?: unknown; mcp?: { server?: unknown } } | null | undefined;
  return meta?.is_mcp_tool_call === true && ANTIGRAVITY_GUGU_SERVERS.includes(meta.mcp?.server as string);
}
