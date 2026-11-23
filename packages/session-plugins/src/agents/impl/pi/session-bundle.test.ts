import { describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { resolveSessionRuntimeCompatible } from '@gugu/session-core/agents/plugins';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { materializePiModelConfig, materializePiSessionBundle, piSessionBundleDescriptor, PI_GUGU_CAPABILITY_PACKAGE } from './session-bundle';

describe('Pi built-in MCP', () => {
  it.each(['tui', 'acp'] as const)('%s registers native HTTP and stdio servers without injecting another MCP extension', (surface) => {
    const bundle: SessionCapabilityBundle = {
      env: { GUGU_HOME: '/gugu', HTTP_AUTH: 'Bearer fixture', STDIO_TOKEN: 'fixture-stdio' },
      mcpServers: [
        { name: 'gugu', transport: 'http', url: 'http://localhost:1234/mcp', authorizationEnv: 'HTTP_AUTH', alwaysLoad: true },
        { name: 'other', transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'STDIO_TOKEN' } },
      ],
      model: null, autonomy: null, promptBlocks: {}, packages: [PI_GUGU_CAPABILITY_PACKAGE],
    };
    const result = materializePiSessionBundle({ surface, lifecycle: 'fresh', cwd: '/work' }, bundle);
    expect(result.argsAppend).toEqual([]);
    expect(JSON.parse(result.env.GUGU_PI_MCP_SERVERS!)).toEqual([
      { name: 'gugu', url: 'http://localhost:1234/mcp', headers: { Authorization: 'Bearer fixture' }, exposure: 'direct' },
      { name: 'other', command: 'node', args: ['server.mjs'], env: { TOKEN: '${STDIO_TOKEN}' }, exposure: 'deferred' },
    ]);
    expect(result.env.HTTP_AUTH).toBeUndefined();
    expect(result.artifacts.some((artifact) => artifact.content.includes('pi-mcp-adapter'))).toBe(false);
  });

  it.each(['tui', 'acp'] as const)('%s refuses a Pi version without built-in MCP and accepts the supported floor', async (surface) => {
    for (const version of ['0.98.0', '0.99.0']) {
      const executionContext = { supportsLocalSpawn: false, exec: async (command: string) => ({ stdout: command === '/pi' ? version : 'v24.14.0', stderr: '' }) } as unknown as IExecutionContext;
      const result = resolveSessionRuntimeCompatible({ providerId: 'pi', surface, descriptor: piSessionBundleDescriptor, executable: '/pi', runtimeExecutable: '/node', executionContext });
      if (version === '0.98.0') await expect(result).rejects.toMatchObject({ code: 'runtime-version-unsupported', installedVersion: version, supportedFloor: '0.99.0' });
      else await expect(result).resolves.toMatchObject({ harnessVersion: version });
    }
  });

  it('still refuses the known-broken Node runtime after Pi passes its own version check', async () => {
    const executionContext = { supportsLocalSpawn: false, exec: async (command: string) => ({ stdout: command === '/pi' ? '1.3.0' : 'v23.7.0', stderr: '' }) } as unknown as IExecutionContext;
    await expect(resolveSessionRuntimeCompatible({ providerId: 'pi', surface: 'tui', descriptor: piSessionBundleDescriptor, executable: '/pi', runtimeExecutable: '/node', executionContext }))
      .rejects.toMatchObject({ code: 'runtime-version-unsupported', runtime: 'node', installedVersion: '23.7.0' });
  });
});

it('writes an identical Pi provider catalog for different custom selections sharing the same model name', () => {
  const base = 'http://127.0.0.1:40000/r';
  const piProviders = ['alpha', 'beta'].map((connectionId) => ({
    connectionId,
    name: connectionId,
    baseUrl: `${base}/${connectionId}/openai-responses`,
    protocol: 'openai-responses' as const,
    models: [{ id: 'same-model', image: true, thinking: true, contextWindow: 32768, maxOutput: 4096 }, { id: 'undeclared' }, { id: 'text-only', image: false }],
  }));
  const materialize = (connectionId: string) => materializePiModelConfig('acp', {
    env: { GUGU_HOME: '/gugu' },
    model: {
      dialect: 'pi-models-json', model: 'same-model',
      platformProvider: { baseUrl: base, apiKey: 'local-token' },
      customModels: { connectionId, entries: piProviders[0]!.models, piProviders },
    },
  });
  const alpha = materialize('alpha');
  const beta = materialize('beta');
  const models = (result: typeof alpha) => result.artifacts.find((artifact) => artifact.path.endsWith('/models.json'))!;
  const settings = (result: typeof alpha) => JSON.parse(result.artifacts.find((artifact) => artifact.path.endsWith('/settings.json'))!.content);
  expect(alpha.env.PI_CODING_AGENT_DIR).toBe(beta.env.PI_CODING_AGENT_DIR);
  expect(models(alpha)).toEqual(models(beta));
  expect(models(alpha).mode).toBe(0o600);
  expect(models(alpha).content).not.toContain('local-token');
  expect(JSON.parse(models(alpha).content).providers).toMatchObject({
    'gugu-alpha': { baseUrl: piProviders[0]!.baseUrl, models: [{ id: 'same-model', maxTokens: 4096, reasoning: true, input: ['text', 'image'] }, { id: 'undeclared', input: ['text', 'image'] }, { id: 'text-only', input: ['text'] }] },
    'gugu-beta': { baseUrl: piProviders[1]!.baseUrl },
  });
  expect(settings(alpha).defaultProvider).toBe('gugu-alpha');
  expect(settings(beta).defaultProvider).toBe('gugu-beta');
});
