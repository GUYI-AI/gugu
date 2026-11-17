import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../../registry';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { normalizeAgentType } from '@gugu/core/agentTypes';

const spawn = { cli: '/bin/agy', cwd: '/work', env: { HOME: '/real-home', GEMINI_HOME: '/gugu/agent-homes/antigravity-cli-acp/.gemini' } };

describe('Antigravity CLI ACP alongside the existing standalone server', () => {
  it('offers the official CLI ACP server without replacing the old provider or its session store', () => {
    const current = pluginRegistry.get('antigravity-cli-acp');
    expect(current).toBeDefined();
    expect(normalizeAgentType('antigravity-cli-acp')).toBe('antigravity');
    expect(current?.behavior.acp?.buildSpawn(spawn)).toMatchObject({
      command: '/bin/agy', args: ['acp', '--stdio', '--gemini-dir', spawn.env.GEMINI_HOME],
    });
    expect(pluginRegistry.get('antigravity')?.behavior.acp?.buildSpawn({ ...spawn, cli: '/bin/agy_acp_server' }))
      .toMatchObject({ command: '/bin/agy_acp_server', args: [] });
  });

  it('uses the managed root through the vendor flag and preserves the shell HOME', () => {
    const current = pluginRegistry.get('antigravity-cli-acp');
    expect(current).toBeDefined();
    expect(current?.behavior.acp?.buildSpawn(spawn).env).not.toHaveProperty('HOME');
    expect(() => current?.behavior.acp?.buildSpawn({ ...spawn, env: { HOME: '/real-home' } })).toThrow(/GEMINI_HOME/);
  });

  it('declares the actual CLI permission ids and independent thinking-level control', () => {
    const current = pluginRegistry.get('antigravity-cli-acp');
    expect(current?.capabilities.autoApprove).toMatchObject({ kind: 'supported', modes: {
      'read-only': { id: 'default' }, edit: { id: 'accept-edits' },
    } });
    expect(current?.capabilities.acp).toMatchObject({ liveSettings: { effort: { channel: 'acp-config-option' } } });
    expect(current?.behavior.acp?.catalogModelSource).toBe('config-options');
    expect(current?.capabilities.hostDependency.binaryNames).toEqual(['agy']);
    expect(current?.capabilities.sessionBundle.surfaces).toEqual(['acp']);
  });

  it('delivers identity and the session MCP server without leaving its bearer token in the child environment', () => {
    const bundle: SessionCapabilityBundle = {
      env: { ...spawn.env, GUGU_MCP_TOKEN: 'Bearer fixture-token' }, model: null, autonomy: null, packages: [],
      promptBlocks: { platform: 'platform ', identity: 'identity' },
      mcpServers: [{ name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', authorizationEnv: 'GUGU_MCP_TOKEN', owner: 'gugu' }],
    };
    const result = pluginRegistry.get('antigravity-cli-acp')!.behavior.sessionBundle!.materialize(
      { cwd: '/work', surface: 'acp', lifecycle: 'fresh' }, bundle,
    );
    expect(result.env).not.toHaveProperty('GUGU_MCP_TOKEN');
    expect(result.prompt).toMatchObject({ value: 'platform identity', carrier: 'session-context' });
    expect(result.acp?.mcpServers).toContainEqual(expect.objectContaining({ name: 'gugu', type: 'http', headers: [{ name: 'Authorization', value: 'Bearer fixture-token' }] }));
    expect(result.report.adapterId).toBe('antigravity-cli-acp');
  });
});
