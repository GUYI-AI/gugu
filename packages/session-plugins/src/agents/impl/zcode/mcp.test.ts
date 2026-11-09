import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { zcodeMcpAdapter } from './mcp';

const fsWith = (files: Record<string, string>): PluginFs =>
  ({ read: async (path: string) => files[path] ?? null }) as unknown as PluginFs;

describe('ZCode: the user MCP servers in ~/.zcode/cli/config.json', () => {
  it('reads mcp.servers, typing each by its `type`', async () => {
    const config = JSON.stringify({
      model: 'x',
      mcp: { servers: { local: { type: 'stdio', command: 'node', args: ['srv.mjs'] }, remote: { type: 'http', url: 'https://example.test/mcp' } } },
    });
    expect(await zcodeMcpAdapter().readServers(fsWith({ '.zcode/cli/config.json': config }))).toEqual([
      { name: 'local', transport: 'stdio', command: 'node', args: ['srv.mjs'] },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp' },
    ]);
  });
});
