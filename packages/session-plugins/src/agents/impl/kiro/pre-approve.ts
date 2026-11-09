import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

/** Gugu's own server in `session/new.mcpServers` (GUGU_MCP_SERVER_NAME on the desktop side). */
const GUGU_SERVER = 'gugu';

/**
 * Gugu's own MCP server never asks, same as on Claude and Codex: an agent must be able to reply in chat with nobody at
 * the approval prompt. Kiro has no per-session rule for this (presets cannot name an MCP server, and permissions.yaml
 * is the user's own file), so the request is answered here. The identity is Kiro's structured `mcpTool` block, never the
 * tool title, which a shell call could imitate. Measured on 3.0.0: `@gugu/ping_probe` under `edit-workspace` asks.
 *
 * The request names the server only, so a user's own MCP server also called `gugu` would pass too.
 */
export function preApproveGuguTool(request: RequestPermissionRequest): string | undefined {
  const kiro = request._meta?.kiro as { mcpTool?: { identity?: { serverName?: unknown } } } | undefined;
  if (kiro?.mcpTool?.identity?.serverName !== GUGU_SERVER) return undefined;
  return request.options.find((option) => option.kind === 'allow_once')?.optionId;
}
