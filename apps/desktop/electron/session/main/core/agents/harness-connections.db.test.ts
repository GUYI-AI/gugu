import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '', codexRoot: '', claudeRoot: '' }));
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
vi.mock('../sessions/subscription-switch', () => ({ prepareSubscriptionMigration: async () => undefined }));
// Claude 凭据一律走文件:❌ 让测试读写跑测试那台机器的登录钥匙串。
vi.mock('./claude-credential-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-credential-store')>();
  return { ...actual, createClaudeCredentialStore: () => actual.createClaudeCredentialStore({ platform: 'linux' }) };
});
const {
  assertHarnessConnectionSelectable,
  connectionConfigRoot,
  createHarnessConnection,
  listHarnessConnections,
  migrateOwnedHarnessAccounts,
  resolveHarnessConnection,
  selectHarnessConnection,
  removeHarnessConnection,
  sessionHarnessConnectionId,
} = await import('./harness-connections');

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connections-'));
  // 「用户自己的配置根」一律指到临时目录:❌ 让测试读写跑测试那台机器上真实的 ~/.codex / ~/.claude。
  vi.stubEnv('GUGU_HOME', join(state.home, 'gugu'));
  state.codexRoot = join(state.home, 'gugu', 'agent-homes', 'codex', '.codex');
  state.claudeRoot = join(state.home, 'gugu', 'agent-homes', 'claude', '.claude');
  vi.stubEnv('CODEX_HOME', join(state.home, 'terminal', '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(state.home, 'terminal', '.claude'));
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
    INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('old', 'project', 'codex', 'pty', '{"version":"1","type":"pty"}');`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

function chatgptAuth(subject: string, refresh = 'r1'): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_id: 'ws' } })).toString('base64url');
  return JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: `h.${payload}.s`, refresh_token: refresh, account_id: 'ws' } });
}

async function writeAuthAt(root: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'auth.json'), text);
}

const vault = (id: string) => join(state.home, 'harness-connections', 'codex', id === 'native' ? 'managed-native' : id, '.codex');

it('references the terminal account and keeps the former native vault as an independent account without writing the terminal', async () => {
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const stateDir = join(state.home, 'harness-connections', 'codex');
  const terminalRoot = process.env.CODEX_HOME!;
  const formerNative = join(stateDir, 'native', '.codex');
  await state.fixture!.registry.setDefaultAccount('harness:codex', work.id);
  await writeAuthAt(terminalRoot, chatgptAuth('work', 'latest'));
  await writeAuthAt(formerNative, chatgptAuth('terminal'));
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  const before = await readFile(join(terminalRoot, 'auth.json'));
  await migrateOwnedHarnessAccounts('codex', process.env);
  await migrateOwnedHarnessAccounts('codex', process.env);
  const connections = await listHarnessConnections('codex');
  expect(connections).toHaveLength(2);
  expect(connections.find(row => row.current)?.id).toBe('native');
  const independent = connections.find(row => row.id !== 'native')!;
  expect(await readFile(join(vault(independent.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('terminal'));
  expect(await readFile(join(terminalRoot, 'auth.json'))).toEqual(before);
  await expect(readFile(join(vault(work.id), 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(state.codexRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await state.fixture!.registry.getAccount('harness:codex', work.id))?.meta?.harnessConnection?.migratedTo).toBe('native');
});

it('migrates copied OAuth into one native reference and removes both managed copies idempotently', async () => {
  const terminal = process.env.CODEX_HOME!;
  const terminalAuth = join(terminal, 'auth.json');
  const managedAuth = join(state.codexRoot, 'auth.json');
  const former = chatgptAuth('person', 'source');
  const copied = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(terminal, former);
  await writeAuthAt(state.codexRoot, chatgptAuth('person', 'old-copy'));
  await writeAuthAt(vault(copied.id), chatgptAuth('person', 'other-copy'));
  await expect(migrateOwnedHarnessAccounts('codex', process.env, true)).resolves.toMatchObject({ upgradeSignIn: 'reference' });
  await expect(readFile(managedAuth)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(vault(copied.id), 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await migrateOwnedHarnessAccounts('codex', process.env, true);
  expect(await listHarnessConnections('codex')).toHaveLength(1);
  expect(await readFile(terminalAuth, 'utf8')).toBe(former);
});

it('asks for Codex sign-in when the existing account uses a keyring, without reading it', async () => {
  const terminal = process.env.CODEX_HOME!;
  await mkdir(terminal, { recursive: true });
  await writeFile(join(terminal, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  await expect(migrateOwnedHarnessAccounts('codex', process.env, true)).resolves.toMatchObject({ upgradeSignIn: 'relogin' });
  await expect(stat(join(state.codexRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('carries the active file-backed Codex API key into the managed slot during upgrade', async () => {
  const terminal = process.env.CODEX_HOME!;
  const former = '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-local-key"}\n';
  await writeAuthAt(terminal, former);
  const result = await migrateOwnedHarnessAccounts('codex', process.env, true);
  expect('upgradeSignIn' in result).toBe(false);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(former);
  expect(await readFile(join(terminal, 'auth.json'), 'utf8')).toBe(former);
});

// #2507 删掉正在用的账号 = 一次切回原生:用户根里换回原来那份登录,删掉的那个号的登录留在它自己的保管目录里。
it('removing the current Codex account falls back to the existing CLI sign-in and leaves the removed one in its vault', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  await selectHarnessConnection('codex', work.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work'));

  await removeHarnessConnection('codex', work.id);
  expect(await listHarnessConnections('codex')).toEqual([
    { id: 'native', kind: 'native', name: '', current: true, endpoint: undefined },
  ]);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  expect(await readFile(join(vault(work.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('work'));
  expect(await sessionHarnessConnectionId('old')).toBe('native');
  // 原生那一份删不掉:它是 CLI 自己的配置。
  await expect(removeHarnessConnection('codex', 'native')).rejects.toThrow('cannot be removed');
});

it('switches Codex by moving credentials through the managed root, keeping rotated tokens with their owner', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  // 不在用户根里的账号:按连接问登录态时读它的保管目录。
  expect(await resolveHarnessConnection('codex', { connectionId: work.id })).toMatchObject({
    credentialHome: join(state.home, 'harness-connections', 'codex', work.id),
    configRootEnv: { CODEX_HOME: vault(work.id) },
  });

  await selectHarnessConnection('codex', work.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('work'));
  expect(await readFile(join(vault('native'), 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  const session = await resolveHarnessConnection('codex', { sessionId: 'old' });
  expect(session.connectionId).toBe(work.id);
  expect(session.configRootEnv).toBeUndefined();
  expect(await sessionHarnessConnectionId('old')).toBe(work.id);
  expect((await resolveHarnessConnection('codex', { connectionId: work.id })).configRootEnv).toBeUndefined();

  // CLI 在用户根里轮换了 refresh token:换走时这份新的要回到 Work 手里。
  await writeAuthAt(state.codexRoot, chatgptAuth('work', 'r2'));
  await selectHarnessConnection('codex', 'native');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  expect(await readFile(join(vault(work.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('work', 'r2'));
  expect(await sessionHarnessConnectionId('old')).toBe('native');
  expect(await sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('can always switch back to the native Codex sign-in, even when the same account was also added as a connection', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const same = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(same.id), chatgptAuth('original', 'r-same'));
  const other = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(other.id), chatgptAuth('other'));
  await selectHarnessConnection('codex', same.id);
  await selectHarnessConnection('codex', 'native');
  await selectHarnessConnection('codex', other.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('other'));
  await selectHarnessConnection('codex', 'native');
  expect(JSON.parse(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).tokens.id_token).toBe(JSON.parse(chatgptAuth('original')).tokens.id_token);
});

it('keeps a copy of an unrecognized sign-in and refuses keychain-backed Codex credentials', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  await selectHarnessConnection('codex', work.id);
  await writeAuthAt(state.codexRoot, chatgptAuth('someone-else'));
  await selectHarnessConnection('codex', 'native');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
  const backups = join(state.home, 'harness-connections', 'codex', 'unrecognized-sign-ins');
  const { readdir } = await import('node:fs/promises');
  const [backup] = await readdir(backups);
  expect(await readFile(join(backups, backup!), 'utf8')).toBe(chatgptAuth('someone-else'));

  await writeFile(join(state.codexRoot, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  await expect(selectHarnessConnection('codex', work.id)).rejects.toThrow('keyring');
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));
});

it('moves every Codex session, including ones pinned before the fix, onto the default subscription', async () => {
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
    VALUES ('ran', 'project', 'codex', 'acp', '{"version":"1","type":"acp","subscriptionConnectionId":"${work.id}"}', 'thread-1'),
           ('fork', 'project', 'codex', 'acp', '{"version":"1","type":"acp","forkedFrom":{"sessionId":"ran","title":"Ran"}}', NULL);`);
  for (const sessionId of ['ran', 'fork', 'old']) {
    const context = await resolveHarnessConnection('codex', { sessionId });
    expect(context.connectionId).toBe('native');
    expect(context.configRootEnv).toBeUndefined();
    expect(await sessionHarnessConnectionId(sessionId)).toBe('native');
  }
  expect((await resolveHarnessConnection('codex', { sessionId: 'runtime-view', sourceSessionId: 'ran' })).connectionId).toBe('native');
});

it('files a first Codex account under its own connection when native never had a sign-in', async () => {
  const first = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  const second = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await writeAuthAt(vault(first.id), chatgptAuth('first'));
  await writeAuthAt(vault(second.id), chatgptAuth('second'));
  await selectHarnessConnection('codex', first.id);
  await writeAuthAt(state.codexRoot, chatgptAuth('first', 'r2'));
  await selectHarnessConnection('codex', second.id);
  // 轮换过的 token 回到 first 手里,❌ 被存到「原生」名下。
  expect(await readFile(join(vault(first.id), 'auth.json'), 'utf8')).toBe(chatgptAuth('first', 'r2'));
  await expect(stat(join(vault('native'), 'auth.json'))).rejects.toThrow();
  await selectHarnessConnection('codex', first.id);
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('first', 'r2'));
});

it('checks a switch before anything is stopped: a missing sign-in or keychain storage is refused up front', async () => {
  await writeAuthAt(state.codexRoot, chatgptAuth('original'));
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account' });
  await expect(assertHarnessConnectionSelectable('codex', work.id)).rejects.toThrow('no saved sign-in');
  await writeAuthAt(vault(work.id), chatgptAuth('work'));
  await assertHarnessConnectionSelectable('codex', work.id);
  await assertHarnessConnectionSelectable('codex', 'native');
  await expect(assertHarnessConnectionSelectable('codex', 'missing')).rejects.toThrow('no longer exists');
  await writeFile(join(state.codexRoot, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  await expect(assertHarnessConnectionSelectable('codex', work.id)).rejects.toThrow('keyring');
  // 只是预检:用户根原样。
  expect(await readFile(join(state.codexRoot, 'auth.json'), 'utf8')).toBe(chatgptAuth('original'));

  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const empty = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await expect(assertHarnessConnectionSelectable('claude', empty.id)).rejects.toThrow('no saved sign-in');
  await writeClaudeSignIn(claudeVault(empty.id), 'u-work', claudeCredential('work', 200));
  await assertHarnessConnectionSelectable('claude', empty.id);
  await assertHarnessConnectionSelectable('claude', 'native');
});

const claudeVault = (id: string) => join(state.home, 'harness-connections', 'claude', id === 'native' ? 'managed-native' : id, '.claude');
const claudeCredential = (access: string, expiresAt: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt }, ...extra });
const accessAt = async (root: string) =>
  (JSON.parse(await readFile(join(root, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
const accountAt = async (root: string) =>
  (JSON.parse(await readFile(join(root, '.claude.json'), 'utf8')) as { oauthAccount: { accountUuid: string } }).oauthAccount.accountUuid;

async function writeClaudeSignIn(root: string, uuid: string, credential: string, config: Record<string, unknown> = {}): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.credentials.json'), credential);
  await writeFile(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid }, hasCompletedOnboarding: true, ...config }));
}

it('switches Claude by moving the sign-in through the managed root and runs every session there on the default', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100, { mcpOAuth: { docs: 'kept' } }), {
    projects: { '/repo': { allowedTools: ['Bash'] } },
  });
  const work = await createHarnessConnection({ providerId: 'claude', kind: 'account', name: 'Work' });
  await writeClaudeSignIn(claudeVault(work.id), 'u-work', claudeCredential('work', 200));
  // 不在用户根里的账号:按连接问登录态时读它的保管目录。
  expect(await resolveHarnessConnection('claude', { connectionId: work.id })).toMatchObject({
    credentialHome: join(state.home, 'harness-connections', 'claude', work.id),
    configRootEnv: { CLAUDE_CONFIG_DIR: claudeVault(work.id) },
  });
  state.fixture!.sqlite.exec(`INSERT INTO sessions (id, project_id, provider, runtime, config)
    VALUES ('pinned', 'project', 'claude', 'acp', '{"version":"1","type":"acp","subscriptionConnectionId":"native"}');`);

  await selectHarnessConnection('claude', work.id);
  expect(await accessAt(state.claudeRoot)).toBe('work');
  expect(JSON.parse(await readFile(join(state.claudeRoot, '.credentials.json'), 'utf8'))).toMatchObject({ mcpOAuth: { docs: 'kept' } });
  expect(await accountAt(state.claudeRoot)).toBe('u-work');
  expect(JSON.parse(await readFile(join(state.claudeRoot, '.claude.json'), 'utf8'))).toMatchObject({ projects: { '/repo': { allowedTools: ['Bash'] } } });
  expect(await accessAt(claudeVault('native'))).toBe('original');
  for (const sessionId of ['pinned', undefined]) {
    const context = await resolveHarnessConnection('claude', sessionId ? { sessionId } : {});
    expect(context.connectionId).toBe(work.id);
    expect(context.configRootEnv).toBeUndefined();
    expect(context.credentialHome).toBeUndefined();
    expect(context.unsetEnv).toContain('ANTHROPIC_API_KEY');
  }
  expect(await sessionHarnessConnectionId('pinned')).toBe(work.id);
  expect((await resolveHarnessConnection('claude', { connectionId: work.id })).configRootEnv).toBeUndefined();

  // CLI 在用户根里轮换了 token:换走时这份新的要回到 Work 手里。
  await writeFile(join(state.claudeRoot, '.credentials.json'), claudeCredential('work-rotated', 300));
  await selectHarnessConnection('claude', 'native');
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect(await accountAt(state.claudeRoot)).toBe('u-original');
  expect(await accessAt(claudeVault(work.id))).toBe('work-rotated');
  expect(await sessionHarnessConnectionId('pinned')).toBe('native');
  expect(await sessionHarnessConnectionId('deleted')).toBeUndefined();
});

it('refuses a Claude account with no saved sign-in and never falls back when a connection is missing', async () => {
  await writeClaudeSignIn(state.claudeRoot, 'u-original', claudeCredential('original', 100));
  const empty = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  await expect(selectHarnessConnection('claude', empty.id)).rejects.toThrow('no saved sign-in');
  expect(await accessAt(state.claudeRoot)).toBe('original');
  expect((await listHarnessConnections('claude')).find((row) => row.current)?.id).toBe('native');
  expect((await resolveHarnessConnection('codex')).connectionId).toBe('native');
  await expect(resolveHarnessConnection('claude', { connectionId: 'missing' })).rejects.toThrow('unavailable');
});

it('a Claude connection config root is where its old sessions ran (now its vault); native and Codex have none', async () => {
  const connection = await createHarnessConnection({ providerId: 'claude', kind: 'account' });
  const asked = await resolveHarnessConnection('claude', { connectionId: connection.id });
  expect(connectionConfigRoot('claude', connection.id)).toBe(asked.configRootEnv?.CLAUDE_CONFIG_DIR);
  expect(connectionConfigRoot('claude', 'native')).toBeNull();
  expect(connectionConfigRoot('codex', connection.id)).toBeNull();
});
