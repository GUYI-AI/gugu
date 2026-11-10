import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { dshMcpBehavior } from './mcp';

const fsWith = (files: Record<string, string>): PluginFs =>
  ({ read: async (path: string) => files[path] ?? null }) as unknown as PluginFs;

describe('DeepSeek Harness: the MCP servers its acp profile inserts', () => {
  it('reads dsh-mcp-client rows from the profile patch; other plugin rows are not servers', async () => {
    const patch = [
      '- insert:',
      '    - id: mcp-local',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config: { serverName: local, transport: stdio, command: node, args: [srv.mjs], env: { K: V } }',
      '    - id: some-other',
      "      name: '@deepseek-ai/dsh-llm-deepseek'",
      '      config: { model: x }',
      '- insert:',
      "    - { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: remote, transport: http, url: 'https://example.test/mcp' } }",
    ].join('\n');
    const servers = await dshMcpBehavior().readServers(fsWith({ '.dsh/profiles/acp/cordis.patch.yml': patch }));
    expect(servers).toEqual([
      { name: 'local', transport: 'stdio', command: 'node', args: ['srv.mjs'], env: { K: 'V' } },
      { name: 'remote', transport: 'http', url: 'https://example.test/mcp' },
    ]);
  });

  it('no profile patch: no servers; a broken one fails loudly', async () => {
    expect(await dshMcpBehavior().readServers(fsWith({}))).toEqual([]);
    await expect(dshMcpBehavior().readServers(fsWith({ '.dsh/profiles/acp/cordis.patch.yml': '- insert: [' }))).rejects.toThrow();
  });
});
