import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * ZCode adapter — `~/.zcode/cli/config.json`, key `mcp.servers`, entries `{ type: 'stdio' | 'http', command, args, url }`
 * (https://zcode.z.ai/en/docs/mcp-services; ZCode 3.17.2 measured 2026-11-09).
 *
 * ⚠️ ZCode needs Gugu to restate these (`sessionUserServers` stays `restate`): measured on 3.17.2 with
 *    `@gugu-acp/zcode-acp` 1.3.1, a `session/new` that lists any server makes ZCode skip the user's own config
 *    entirely — and Gugu always lists its own server — while a restated server starts exactly once.
 */
export function zcodeMcpAdapter(configPath = '.zcode/cli/config.json') {
  return createMcpAdapter({
    configPath,
    format: 'json',
    serversKey: 'mcp.servers',
    toNative(s) {
      const { name: _name, transport, ...entry } = s;
      return { ...entry, type: transport === 'http' ? 'http' : 'stdio' };
    },
    fromNative(name, raw) {
      const { type, ...entry } = cloneMcpEntry(raw) as Record<string, unknown>;
      return { name, ...entry, transport: type === 'http' ? 'http' : 'stdio' } as McpServerRegistration;
    },
  });
}
