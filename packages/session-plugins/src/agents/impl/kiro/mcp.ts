import { passthroughMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';

/** Kiro's user-level MCP config: `~/.kiro/settings/mcp.json`, key `mcpServers` (kiro.dev/docs/mcp). */
export function kiroMcpAdapter(configPath = '.kiro/settings/mcp.json') {
  return passthroughMcpAdapter(configPath);
}
