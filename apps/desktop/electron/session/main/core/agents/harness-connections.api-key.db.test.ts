/**
 * #2507 其余家的 API Key 连接:哪些家收(插件注册表说了算)、表单格子照声明核、key 只在主进程解出来、
 * 选中后会话照它起,原生连接一个字都不加(与没有连接时逐字节一样)。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '' }));
vi.mock('@main/db/client', () => ({
  get db() {
    return state.fixture!.db;
  },
}));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({
  get providerAccountRegistry() {
    return state.fixture!.registry;
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => state.home } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const {
  assertHarnessConnectionSelectable,
  createHarnessConnection,
  harnessHasConnections,
  listHarnessConnections,
  removeHarnessConnection,
  resolveHarnessConnection,
  selectHarnessConnection,
  sessionHarnessConnectionId,
} = await import('./harness-connections');

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-api-key-connections-'));
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
    INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('qwen-session', 'project', 'qwen', 'acp', '{"version":"1","type":"acp"}'),
           ('kiro-session', 'project', 'kiro', 'acp', '{"version":"1","type":"acp"}');`);
});
afterEach(async () => {
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

it('only Claude, Codex and the agents that declare an API key mapping have connections', async () => {
  for (const id of ['claude', 'codex', 'qwen', 'dsh', 'copilot', 'mimocode', 'kilocode', 'zcode']) expect(harnessHasConnections(id), id).toBe(true);
  for (const id of ['kiro', 'hermes', 'opencode', 'pi', 'no-such-agent']) expect(harnessHasConnections(id), id).toBe(false);
  await expect(listHarnessConnections('kiro')).rejects.toThrow('unavailable');
  await expect(createHarnessConnection({ providerId: 'kiro', kind: 'api-key', apiKey: 'k' })).rejects.toThrow('unavailable');
  await expect(createHarnessConnection({ providerId: 'no-such-agent', kind: 'api-key', apiKey: 'k' })).rejects.toThrow('unavailable');
  // 没有连接的家起进程时一个字都不加。
  expect(await resolveHarnessConnection('kiro')).toEqual({});
});

it('checks the form against the declaration: no account connections, required address and model, nothing extra', async () => {
  await expect(createHarnessConnection({ providerId: 'qwen', kind: 'account' })).rejects.toThrow('own CLI');
  await expect(createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', model: 'm' })).rejects.toThrow('address is required');
  await expect(createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', endpoint: 'https://g.example/v1' })).rejects.toThrow('model is required');
  await expect(createHarnessConnection({ providerId: 'mimocode', kind: 'api-key', apiKey: 'k', endpoint: 'https://g.example' })).rejects.toThrow('official API key');
  await expect(createHarnessConnection({ providerId: 'dsh', kind: 'api-key', apiKey: 'k', model: 'm' })).rejects.toThrow('no model');
  // Claude / Codex 的 API 连接一如既往:地址可选、没有模型格。
  await expect(createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'k', model: 'm' })).rejects.toThrow('no model');
  expect(await createHarnessConnection({ providerId: 'dsh', kind: 'api-key', apiKey: 'k' })).toMatchObject({ kind: 'api-key', name: 'DeepSeek Harness 1' });
});

it('keeps the key out of the metadata, starts sessions on the selected key, and adds nothing on the native connection', async () => {
  // 原生连接:与没有连接时逐字节一样。
  expect(await resolveHarnessConnection('qwen')).toEqual({});
  expect(await sessionHarnessConnectionId('qwen-session')).toBe('native');

  const connection = await createHarnessConnection({
    providerId: 'qwen',
    kind: 'api-key',
    apiKey: 'test-secret',
    endpoint: 'https://gateway.example/v1/',
    model: 'qwen3-coder-plus',
  });
  expect(connection).toMatchObject({ kind: 'api-key', name: 'gateway.example', endpoint: 'https://gateway.example/v1', model: 'qwen3-coder-plus', current: false });
  const listed = await listHarnessConnections('qwen');
  expect(listed.map((row) => row.id)).toEqual(['native', connection.id]);
  expect(JSON.stringify(listed)).not.toContain('test-secret');
  expect(
    state.fixture!.sqlite.prepare('SELECT meta FROM provider_accounts').all().map((row) => JSON.stringify(row)).join('')
  ).not.toContain('test-secret');

  // 没选之前,会话还在原生上;按连接问的(菜单里那一行的登录态)才解出这把 key。
  expect(await resolveHarnessConnection('qwen', { sessionId: 'qwen-session' })).toEqual({});
  expect(await resolveHarnessConnection('qwen', { connectionId: connection.id })).toMatchObject({
    connectionId: connection.id,
    credentialEnv: { OPENAI_API_KEY: 'test-secret' },
    apiKeyConnection: { endpoint: 'https://gateway.example/v1' },
  });

  await assertHarnessConnectionSelectable('qwen', connection.id);
  await selectHarnessConnection('qwen', connection.id);
  for (const input of [{ sessionId: 'qwen-session' }, {}]) {
    expect(await resolveHarnessConnection('qwen', input)).toEqual({
      connectionId: connection.id,
      credentialEnv: { OPENAI_API_KEY: 'test-secret', OPENAI_BASE_URL: 'https://gateway.example/v1', OPENAI_MODEL: 'qwen3-coder-plus' },
      unsetEnv: ['QWEN_OAUTH', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'QWEN_MODEL'],
      apiKeyConnection: { endpoint: 'https://gateway.example/v1' },
    });
  }
  expect(await sessionHarnessConnectionId('qwen-session')).toBe(connection.id);
  expect(await sessionHarnessConnectionId('kiro-session')).toBe('native');

  await expect(removeHarnessConnection('qwen', connection.id)).rejects.toThrow('Select another');
  await selectHarnessConnection('qwen', 'native');
  expect(await resolveHarnessConnection('qwen', { sessionId: 'qwen-session' })).toEqual({});
  await removeHarnessConnection('qwen', connection.id);
  expect((await listHarnessConnections('qwen')).map((row) => row.id)).toEqual(['native']);
});

it('an official key connection needs no address and still reads as the selected API key', async () => {
  const connection = await createHarnessConnection({ providerId: 'kilocode', kind: 'api-key', apiKey: 'kilo-secret' });
  expect(connection.name).toBe('Kilo 1');
  await selectHarnessConnection('kilocode', connection.id);
  expect(await resolveHarnessConnection('kilocode')).toEqual({
    connectionId: connection.id,
    credentialEnv: { KILO_API_KEY: 'kilo-secret' },
    unsetEnv: ['KILO_API_KEY'],
    apiKeyConnection: {},
  });
});
