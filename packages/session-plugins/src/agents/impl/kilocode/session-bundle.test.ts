import { describe, expect, it } from 'vitest';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { harnessPinnedEnv } from '@gugu/session-core/agents/plugins';
import { kilocodeModelCredential } from './auth';
import { kilocodeSessionBundleDescriptor, materializeKilocodeSessionBundle } from './session-bundle';

const GUGU_HOME = '/gugu-home-under-test';

function materialize(surface: 'acp' | 'tui', permissionMode: string) {
  const out = materializeKilocodeSessionBundle(
    { surface, lifecycle: 'fresh', cwd: '/worktree' },
    {
      mcpServers: [
        { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp' },
        { name: 'connected-apps', transport: 'http', url: 'http://127.0.0.1:2/mcp', owner: 'gugu' },
        { name: 'mine', transport: 'http', url: 'http://127.0.0.1:3/mcp', owner: 'user' },
      ],
      env: { GUGU_HOME },
      model: null,
      autonomy: { mode: permissionMode === 'full-access' ? 'full-access' : 'approval-required', permissionMode },
      promptBlocks: { platform: 'PLATFORM', identity: 'IDENTITY' },
      packages: [],
    } as never,
  );
  return { out, config: JSON.parse(out.env.KILO_CONFIG_CONTENT!) as Record<string, any> };
}

describe('Kilo session bundle', () => {
  it('keeps Gugu tools usable in guarded modes, but not the servers the user added', () => {
    for (const mode of ['plan', 'ask']) {
      expect(materialize('acp', 'read-only').config.agent[mode].permission).toEqual({
        'gugu_*': 'allow',
        'connected-apps_*': 'allow',
      });
    }
  });

  it('keeps approvals on the code agent whatever the spawn mode, because the session can switch live', () => {
    for (const mode of ['plan', 'read-only', 'edit', 'full-access']) {
      expect(materialize('acp', mode).config.agent.code.permission.bash).toBe('ask');
    }
  });

  it('declares full access as a real mode and keeps the top level open for subagents', () => {
    const { config } = materialize('acp', 'full-access');
    expect(config.permission).toBe('allow');
    expect(config.agent['full-access'].permission).toEqual({ '*': 'allow' });
    expect(config.agent.general).toBeUndefined();
    expect(config.agent.explore).toBeUndefined();
  });

  it('denies gated tools in the ACP subagent, whose approval request Kilo would drop', () => {
    expect(materialize('acp', 'edit').config.agent.general.permission.bash).toBe('deny');
    const { explore, scout } = materialize('acp', 'edit').config.agent;
    expect(explore.permission.webfetch).toBe('deny');
    expect(explore.permission.external_directory).toBe('deny');
    expect(explore.permission.bash).toBeUndefined();
    // Naming an agent Kilo has not registered creates it.
    expect(scout).toBeUndefined();
    expect(materialize('tui', 'edit').config.agent.general).toBeUndefined();
    expect(materialize('tui', 'edit').config.permission.bash).toBe('ask');
  });

  it('selects the agent at session creation for the serve leg', () => {
    expect(materialize('tui', 'plan').out.sessionCreatePatch).toEqual({ agent: 'plan' });
    expect(materialize('tui', 'read-only').out.sessionCreatePatch).toEqual({ agent: 'ask' });
    expect(materialize('tui', 'full-access').out.sessionCreatePatch).toEqual({ agent: 'full-access' });
    expect(materialize('tui', 'edit').out.sessionCreatePatch).toBeUndefined();
  });

  it('keeps small requests on a Gugu model, and only then', () => {
    const run = (model: string) => JSON.parse(materializeKilocodeSessionBundle(
      { surface: 'acp', lifecycle: 'fresh', cwd: '/worktree' },
      {
        mcpServers: [], model: null, autonomy: null, promptBlocks: {}, packages: [],
        env: { GUGU_HOME, KILO_CONFIG_CONTENT: JSON.stringify({ model }) },
      } as never,
    ).env.KILO_CONFIG_CONTENT!);
    expect(run('gugu-platform/gpt-6-luna').small_model).toBe('gugu-platform/gpt-6-luna');
    expect(run('kilo/auto').small_model).toBeUndefined();
  });

  it('retires the workspace plugin instead of writing it', () => {
    const { out } = materialize('acp', 'edit');
    expect(out.artifacts.map((artifact) => artifact.path)).not.toContain('/worktree/.kilo/plugins/gugu-notifications.js');
    expect(out.retiredArtifacts?.[0]?.path).toBe('/worktree/.kilo/plugins/gugu-notifications.js');
  });
});

describe('Kilo default model credential', () => {
  const ctx = (env: Record<string, string>, files: Record<string, string> = {}) =>
    ({ env, fs: { read: async (path: string) => files[path] ?? null } }) as never;

  it('reads its built-in gateway without a models.dev snapshot', async () => {
    expect(await kilocodeModelCredential(ctx({}), 'kilo/google/gemini-3-pro-image')).toBe('uncredentialed');
    expect(await kilocodeModelCredential(ctx({ KILO_API_KEY: 'k' }), 'kilo/x')).toBe('credentialed');
    expect(await kilocodeModelCredential(ctx({}, { '.local/share/kilo/auth.json': '{"kilo":{}}' }), 'kilo/x')).toBe('credentialed');
  });

  it('stays unknown for other providers when the snapshot is missing', async () => {
    expect(await kilocodeModelCredential(ctx({}), 'openai/gpt')).toBe('unknown');
  });
});

describe('Kilo pinned env', () => {
  it('reaches every process of the harness and wins over the user', () => {
    const pinned = harnessPinnedEnv(kilocodeSessionBundleDescriptor);
    expect(pinned).toEqual({
      KILO_DISABLE_AUTOUPDATE: '1',
      KILO_TELEMETRY_LEVEL: 'off',
      KILO_DISABLE_SESSION_INGEST: '1',
    });
    const env = composeAgentSpawnEnv({
      cli: { kind: 'unresolved', message: 'env-only' },
      env: { KILO_TELEMETRY_LEVEL: 'all' },
      configRootEnv: {},
      pinnedEnv: { ...pinned },
      extraArgs: [],
    });
    expect(env.KILO_TELEMETRY_LEVEL).toBe('off');
  });
});
