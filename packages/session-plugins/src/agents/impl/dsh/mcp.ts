import { readYamlValue } from '@gugu/session-core/agents/plugins/helpers';
import type { IMcpBehavior, McpServerRegistration, PluginFs } from '@gugu/session-core/agents/plugins';

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

/**
 * DeepSeek Harness has no MCP file: a server is a plugin row `@deepseek-ai/dsh-mcp-client` with
 * `config: { serverName, transport, command, args, url, env, headers }`, inserted by the profile's patch file
 * (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, a list of `- insert: [<rows>]` operations; dsh-mcp-client README).
 * Gugu starts dsh with `--profile acp`, so that profile is the one read.
 *
 * Read only: dsh starts these itself when the profile boots, before `session/new` (measured 0.2.2-rc.1, 2026-11-09),
 * so Gugu declares `sessionUserServers: 'inherit'` and never restates or writes them.
 */
export function dshMcpBehavior(patchPath = '.dsh/profiles/acp/cordis.patch.yml'): IMcpBehavior {
  return {
    async readServers(fs: PluginFs): Promise<McpServerRegistration[]> {
      const operations = await readYamlValue(fs, patchPath);
      if (!Array.isArray(operations)) return [];
      return operations
        .flatMap((operation) => (Array.isArray((operation as { insert?: unknown })?.insert) ? (operation as { insert: unknown[] }).insert : []))
        .flatMap((row) => {
          const { name, config } = (row ?? {}) as { name?: unknown; config?: Record<string, unknown> };
          if (name !== MCP_CLIENT || typeof config?.serverName !== 'string') return [];
          const { serverName, transport, ...target } = config;
          return [{ name: serverName, ...target, transport: transport === 'stdio' ? 'stdio' : 'http' } as McpServerRegistration];
        });
    },
    async writeServers(): Promise<void> {
      throw new Error('MCP settings are read-only in Gugu: edit the DeepSeek Harness profile patch instead.');
    },
    async removeServer(): Promise<void> {
      throw new Error('MCP settings are read-only in Gugu: edit the DeepSeek Harness profile patch instead.');
    },
  };
}
