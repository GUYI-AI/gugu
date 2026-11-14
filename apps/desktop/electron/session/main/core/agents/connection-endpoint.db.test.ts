/**
 * #2507 第 6 轮(owner 2026-11-12「地址 + Key 是主体:官方和中转一视同仁」):
 * 地址预填官方、没改就读作官方;模型从 `{地址}/models` 读、可以点名好几个;pi / opencode 按地址探接口。
 *
 * 从头走到尾:真的连接表 → 真的 `harness-connections`(读清单、探接口、存、解析会话要跑的那把)→ 真的
 * `connectionModelLaunch` 与 pi 的 models.json 写法。对面是本机起的假中转:一台只讲 Chat Completions、报模型清单
 * (未知路由照 new-api 的 `RelayNotFound` 回 404 JSON);一台只讲 Responses、不报清单。
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { apiKeyConnectionPlan } from '@gugu/session-core/agents/plugins';
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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const {
  createHarnessConnection,
  listHarnessConnections,
  readConnectionModels,
  resolveConnectionModel,
  resolveHarnessConnection,
  selectHarnessConnection,
  updateHarnessConnectionModels,
} = await import('./harness-connections');
const { createProbeConnectionCredentials } = await import('../../../../harness-catalog-probe-connection');

type Hit = { server: string; method: string; path: string; authorization: string | null; body: string };
const hits: Hit[] = [];
const KEY = 'relay-secret';

/** 一台假中转。`chat` / `responses`:讲不讲这个接口;`models`:报不报清单。未知路由一律 404 JSON(new-api 的 RelayNotFound)。 */
function fakeRelay(name: string, speaks: { chat: boolean; responses: boolean; models: string[] | null }): Server {
  return createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits.push({ server: name, method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization ?? null, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const notFound = () => json(404, { error: { message: `Invalid URL (${req.method} ${req.url})`, type: 'invalid_request_error' } });
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: 'Invalid token', type: 'invalid_request_error' } });
      if (req.method === 'GET' && req.url === '/v1/models') {
        return speaks.models ? json(200, { object: 'list', data: speaks.models.map((id) => ({ id, object: 'model' })) }) : notFound();
      }
      const served = (req.url === '/v1/chat/completions' && speaks.chat) || (req.url === '/v1/responses' && speaks.responses);
      if (req.method === 'POST' && served) return json(400, { error: { message: 'model is required', type: 'invalid_request_error' } });
      return notFound();
    });
  });
}

const chatRelay = fakeRelay('chat-only', { chat: true, responses: false, models: ['relay-b', 'relay-a', 'relay-a'] });
const responsesRelay = fakeRelay('responses-only', { chat: false, responses: true, models: null });
let chatUrl = '';
let responsesUrl = '';
const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)));

beforeAll(async () => {
  chatUrl = await listen(chatRelay);
  responsesUrl = await listen(responsesRelay);
});
afterAll(async () => {
  await new Promise((resolve) => chatRelay.close(resolve));
  await new Promise((resolve) => responsesRelay.close(resolve));
});
beforeEach(async () => {
  hits.length = 0;
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connection-endpoint-'));
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
    INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('pi-session', 'project', 'pi', 'acp', '{"version":"1","type":"acp","model":"relay-b"}'),
           ('qwen-session', 'project', 'qwen', 'acp', '{"version":"1","type":"acp","model":"q-2"}');`);
});
afterEach(async () => {
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

it('reads an address’s model list in the host, with the key sent only to that address', async () => {
  expect(await readConnectionModels({ providerId: 'pi', apiKey: KEY, endpoint: chatUrl })).toEqual({ kind: 'listed', models: ['relay-a', 'relay-b'] });
  expect(hits).toEqual([expect.objectContaining({ server: 'chat-only', method: 'GET', path: '/v1/models', authorization: `Bearer ${KEY}` })]);
  // 读不到就说为什么,表单退回手填。
  expect(await readConnectionModels({ providerId: 'pi', apiKey: KEY, endpoint: responsesUrl })).toEqual({ kind: 'unlisted', reason: 'no-list' });
  expect(await readConnectionModels({ providerId: 'pi', apiKey: 'wrong', endpoint: chatUrl })).toEqual({ kind: 'unlisted', reason: 'unauthorized' });
  expect(await readConnectionModels({ providerId: 'pi', apiKey: KEY, endpoint: 'http://127.0.0.1:9/v1' })).toEqual({ kind: 'unlisted', reason: 'unreachable' });
  // 不点名模型的家没有这一格。
  await expect(readConnectionModels({ providerId: 'dsh', apiKey: KEY })).rejects.toThrow('no model');
});

it('a relay that only speaks Chat Completions: detected at creation without spending a token, and pi writes `openai-completions`', async () => {
  const connection = await createHarnessConnection({ providerId: 'pi', kind: 'api-key', apiKey: KEY, endpoint: chatUrl, models: ['relay-a', 'relay-b'] });
  // 探的两下都是空请求体:没点名模型,上游一个 token 都不花。
  const probes = hits.filter((hit) => hit.method === 'POST');
  expect(probes.map((hit) => [hit.path, hit.body])).toEqual([['/v1/responses', '{}'], ['/v1/chat/completions', '{}']]);
  expect(listHarnessConnections('pi')).resolves.toContainEqual(
    expect.objectContaining({ id: connection.id, endpoint: chatUrl, models: ['relay-a', 'relay-b'] })
  );
  await selectHarnessConnection('pi', connection.id);
  // 会话在新建任务里选的是 relay-b ⇒ 它是起步模型,另一个也在声明里。
  const resolved = await resolveConnectionModel('pi', 'pi-session');
  expect(resolved).toMatchObject({ endpoint: chatUrl, apiKey: KEY, models: ['relay-b', 'relay-a'], protocol: 'openai-chat-completions' });
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-connection-endpoint-pi-'));
  try {
    const credentials = await createProbeConnectionCredentials((id) => resolveConnectionModel(id, 'pi-session'))('pi', scratch);
    const document = JSON.parse(readFileSync(join(credentials!.env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
    const provider = Object.values(document.providers)[0] as { api: string; baseUrl: string; models: { id: string; api: string }[] };
    expect(provider).toMatchObject({ api: 'openai-completions', baseUrl: chatUrl });
    expect(provider.models.map((model) => [model.id, model.api])).toEqual([
      ['relay-b', 'openai-completions'],
      ['relay-a', 'openai-completions'],
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('a relay that speaks Responses keeps Responses', async () => {
  await createHarnessConnection({ providerId: 'opencode', kind: 'api-key', apiKey: KEY, endpoint: responsesUrl, models: ['m'] });
  // 第一下就探到了,不再探第二种。
  expect(hits.filter((hit) => hit.method === 'POST').map((hit) => hit.path)).toEqual(['/v1/responses']);
  const [connection] = (await listHarnessConnections('opencode')).filter((row) => row.kind === 'api-key');
  await selectHarnessConnection('opencode', connection!.id);
  expect(await resolveConnectionModel('opencode')).toMatchObject({ protocol: 'openai-responses' });
});

it('an unchanged official address is stored as no address and reads as official; a relay address reads as itself', async () => {
  const official = await createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: KEY, endpoint: 'https://api.openai.com/v1/', models: ['q-1', 'q-2'] });
  expect(official).not.toHaveProperty('endpoint');
  // 名字也按官方起(「Qwen Code 1」这类),❌ 叫成主机名。
  expect(official.name).not.toContain('api.openai.com');
  await selectHarnessConnection('qwen', official.id);
  const run = await resolveHarnessConnection('qwen', { sessionId: 'qwen-session' });
  // 付款方 / 用量照「没有地址」读:官方 API Key,❌「自定义服务」。标记里带着环境点名的那个模型(运行时据此不再设模型)。
  expect(run.apiKeyConnection).toEqual({ model: 'q-2' });
  expect(apiKeyConnectionPlan(run.apiKeyConnection?.endpoint)).toEqual({ payer: 'api-key' });
  // 进程照样拿到官方地址(qwen 离了地址起不来),跑会话选的那个模型。
  expect(run.credentialEnv).toMatchObject({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODEL: 'q-2' });
  // 没有会话(探针、登录态)⇒ 第一个。
  expect((await resolveHarnessConnection('qwen')).credentialEnv).toMatchObject({ OPENAI_MODEL: 'q-1' });

  const relay = await createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: KEY, endpoint: chatUrl, models: ['q-1'] });
  expect(relay.endpoint).toBe(chatUrl);
  await selectHarnessConnection('qwen', relay.id);
  expect((await resolveHarnessConnection('qwen', { sessionId: 'qwen-session' })).apiKeyConnection).toEqual({ endpoint: chatUrl, model: 'q-1' });

  // Claude 同一条:官方地址不记,不给 ANTHROPIC_BASE_URL。
  const claude = await createHarnessConnection({ providerId: 'claude', kind: 'api-key', apiKey: 'sk-ant', endpoint: 'https://api.anthropic.com' });
  expect(claude).not.toHaveProperty('endpoint');
});

it('manage models: a saved connection’s models change in place and its list is read with its own key', async () => {
  const connection = await createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: KEY, endpoint: chatUrl, models: ['relay-a'] });
  hits.length = 0;
  expect(await readConnectionModels({ providerId: 'qwen', connectionId: connection.id })).toEqual({ kind: 'listed', models: ['relay-a', 'relay-b'] });
  expect(hits[0]?.authorization).toBe(`Bearer ${KEY}`);
  const updated = await updateHarnessConnectionModels('qwen', connection.id, ['relay-b', 'relay-a']);
  expect(updated).toMatchObject({ id: connection.id, endpoint: chatUrl, models: ['relay-b', 'relay-a'] });
  expect(await listHarnessConnections('qwen')).toContainEqual(expect.objectContaining({ id: connection.id, models: ['relay-b', 'relay-a'] }));
  // 换模型不动它的 key:还读得出清单,选中后进程拿到的仍是这把 key。
  expect(await readConnectionModels({ providerId: 'qwen', connectionId: connection.id })).toMatchObject({ kind: 'listed' });
  await selectHarnessConnection('qwen', connection.id);
  expect((await resolveHarnessConnection('qwen')).credentialEnv).toMatchObject({ OPENAI_API_KEY: KEY, OPENAI_MODEL: 'relay-b' });
  await expect(updateHarnessConnectionModels('qwen', connection.id, [])).rejects.toThrow('at least one model');
  await expect(updateHarnessConnectionModels('dsh', 'native', ['m'])).rejects.toThrow('no model');
});

it('a connection saved before this change (one model, official address written out) reads in the new shape', async () => {
  await state.fixture!.registry.upsertAccount({
    providerId: 'harness:pi',
    accountId: 'legacy',
    secret: KEY,
    meta: { displayName: 'Pi 1', harnessConnection: { kind: 'api-key', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.5' } },
  });
  const [legacy] = (await listHarnessConnections('pi')).filter((row) => row.id === 'legacy');
  // 官方地址读作「没有地址」,一个模型读成一组。
  expect(legacy).toEqual({ id: 'legacy', kind: 'api-key', name: 'Pi 1', models: ['gpt-5.5'], current: legacy!.current });
  await selectHarnessConnection('pi', 'legacy');
  expect(await resolveConnectionModel('pi')).toMatchObject({ endpoint: 'https://api.openai.com/v1', models: ['gpt-5.5'] });
  expect(await resolveHarnessConnection('pi', { sessionId: 'pi-session' })).toMatchObject({ apiKeyConnection: {} });
});
