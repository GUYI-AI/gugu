import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { activateCodexAccount, codexAuthIdentity, copyCodexUpgradeSignIn, restoreCodexTerminalForMigration, type CodexAuthSlotPaths } from './codex-auth-slot';
import { activateClaudeAccount, restoreClaudeTerminalForMigration, type ClaudeAuthSlotPaths } from './claude-auth-slot';
import { createClaudeCredentialStore } from './claude-credential-store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rename).mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'managed-account-migration-'));
  roots.push(path); return path;
}
async function put(root: string, file: string, text: string) {
  await mkdir(root, { recursive: true }); await writeFile(join(root, file), text);
}
async function fileHash(root: string, file: string) {
  return createHash('sha256').update(await readFile(join(root, file))).digest('hex');
}
function codexAuth(account: string, refresh: string) {
  const payload = Buffer.from(JSON.stringify({ sub: account, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace' } })).toString('base64url');
  return JSON.stringify({ tokens: { id_token: `header.${payload}.signature`, refresh_token: refresh } });
}
function codexPaths(root: string): CodexAuthSlotPaths {
  return { nativeRoot: join(root, 'terminal'), vaultRoot: (id) => join(root, 'vaults', id),
    backupDir: join(root, 'backup'), liveStateFile: join(root, 'old-live.json') };
}

it('leaves the accurate Codex ownership record on disk during concurrent launch preparation', async () => {
  const paths = codexPaths(await root());
  const ids = ['native', 'gugu-a'];
  const auth = codexAuth('gugu-a', 'rotated');
  await put(paths.nativeRoot, 'auth.json', auth);
  const record = { connectionId: 'gugu-a', identity: codexAuthIdentity(JSON.parse(auth)) };
  await writeFile(paths.liveStateFile, JSON.stringify(record));
  await utimes(paths.liveStateFile, new Date(0), new Date(0));
  const before = await stat(paths.liveStateFile);

  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const prepare = () => activateCodexAccount(paths, ids, 'gugu-a', 'gugu-a');
  expect(await Promise.allSettled([prepare(), prepare(), prepare()])).toEqual(
    Array.from({ length: 3 }, () => ({ status: 'fulfilled', value: 'gugu-a' })),
  );

  expect((await stat(paths.liveStateFile)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(auth);
});

it('repairs missing Codex ownership metadata without replacing the live sign-in', async () => {
  const paths = codexPaths(await root());
  const ids = ['native', 'gugu-a'];
  const auth = codexAuth('gugu-a', 'rotated');
  await put(paths.nativeRoot, 'auth.json', auth);
  await put(paths.vaultRoot('gugu-a'), 'auth.json', codexAuth('gugu-a', 'old'));
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const prepare = () => activateCodexAccount(paths, ids, 'gugu-a', 'gugu-a');

  expect(await Promise.allSettled([prepare(), prepare()])).toEqual([
    { status: 'fulfilled', value: 'gugu-a' },
    { status: 'fulfilled', value: 'gugu-a' },
  ]);
  expect(JSON.parse(await readFile(paths.liveStateFile, 'utf8'))).toEqual({
    connectionId: 'gugu-a', identity: codexAuthIdentity(JSON.parse(auth)),
  });
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(auth);
});

it('activates a saved Codex account once when launch preparations run concurrently', async () => {
  const paths = codexPaths(await root());
  const ids = ['native', 'gugu-a'];
  const native = codexAuth('terminal', 'latest');
  const incoming = codexAuth('gugu-a', 'saved');
  await put(paths.nativeRoot, 'auth.json', native);
  await put(paths.vaultRoot('gugu-a'), 'auth.json', incoming);
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const prepare = () => activateCodexAccount(paths, ids, 'gugu-a', 'native');

  const results = await Promise.allSettled([prepare(), prepare(), prepare()]);
  expect(results).toEqual([
    { status: 'fulfilled', value: 'native' },
    { status: 'fulfilled', value: 'gugu-a' },
    { status: 'fulfilled', value: 'gugu-a' },
  ]);
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(incoming);
  expect(await readFile(join(paths.vaultRoot('native'), 'auth.json'), 'utf8')).toBe(native);
});

it('restores credentials when the ownership record cannot be published', async () => {
  const paths = codexPaths(await root());
  const active = codexAuth('gugu-a', 'rotated');
  const saved = codexAuth('gugu-a', 'old');
  const incoming = codexAuth('gugu-b', 'saved');
  const record = JSON.stringify({ connectionId: 'gugu-a', identity: codexAuthIdentity(JSON.parse(active)) });
  await put(paths.nativeRoot, 'auth.json', active);
  await put(paths.vaultRoot('gugu-a'), 'auth.json', saved);
  await put(paths.vaultRoot('gugu-b'), 'auth.json', incoming);
  await writeFile(paths.liveStateFile, record);
  const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
  const failure = Object.assign(new Error('Cannot replace the ownership record'), { code: 'EIO' });
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (to === paths.liveStateFile) throw failure;
    return realRename(from, to);
  });

  const activate = () => activateCodexAccount(paths, ['native', 'gugu-a', 'gugu-b'], 'gugu-b', 'gugu-a');
  await expect(activate()).rejects.toBe(failure);
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(active);
  expect(await readFile(join(paths.vaultRoot('gugu-a'), 'auth.json'), 'utf8')).toBe(saved);
  expect(await readFile(join(paths.vaultRoot('gugu-b'), 'auth.json'), 'utf8')).toBe(incoming);
  expect(await readFile(paths.liveStateFile, 'utf8')).toBe(record);
  vi.mocked(rename).mockReset();
  await expect(activate()).resolves.toBe('gugu-a');
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(incoming);
});

it('publishes concurrent Codex migration records with independent temporary files', async () => {
  const previous = codexPaths(await root());
  const managed = codexPaths(await root());
  const auth = { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' };
  await put(previous.nativeRoot, 'auth.json', JSON.stringify(auth));
  await put(managed.nativeRoot, 'auth.json', JSON.stringify(auth));

  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const migrate = () => copyCodexUpgradeSignIn(previous, managed, 'native');
  expect(await Promise.allSettled([migrate(), migrate(), migrate()])).toEqual(
    Array.from({ length: 3 }, () => ({ status: 'fulfilled', value: 'api-key' })),
  );
  expect(JSON.parse(await readFile(managed.liveStateFile, 'utf8'))).toEqual({
    connectionId: 'native', identity: codexAuthIdentity(auth),
  });
});

it('moves the latest Gugu Codex token through its vault while restoring the terminal account', async () => {
  const dir = await root(), old = codexPaths(dir), ids = ['native', 'gugu-a'];
  await put(old.nativeRoot, 'auth.json', codexAuth('terminal-b', 'b-current'));
  await put(old.vaultRoot('gugu-a'), 'auth.json', codexAuth('gugu-a', 'a-old'));
  await activateCodexAccount(old, ids, 'gugu-a', 'native');
  await put(old.nativeRoot, 'auth.json', codexAuth('gugu-a', 'a-rotated'));
  await restoreCodexTerminalForMigration(old, ids);
  const managed = { ...old, nativeRoot: join(dir, 'managed'), liveStateFile: join(dir, 'managed-live.json'),
    vaultRoot: (id: string) => id === 'native' ? join(dir, 'managed-native') : old.vaultRoot(id) };
  await activateCodexAccount(managed, ids, 'gugu-a', 'native');
  expect(await readFile(join(old.nativeRoot, 'auth.json'), 'utf8')).toBe(codexAuth('terminal-b', 'b-current'));
  expect(await readFile(join(managed.nativeRoot, 'auth.json'), 'utf8')).toBe(codexAuth('gugu-a', 'a-rotated'));
  await expect(readFile(join(old.vaultRoot('native'), 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(activateCodexAccount(managed, ids, 'native', 'gugu-a')).rejects.toThrow('no saved sign-in');
  const managedBefore = await fileHash(managed.nativeRoot, 'auth.json');
  await put(old.nativeRoot, 'auth.json', codexAuth('terminal-b', 'b-refreshed'));
  expect(await fileHash(managed.nativeRoot, 'auth.json')).toBe(managedBefore);
  const terminalBefore = await fileHash(old.nativeRoot, 'auth.json');
  await put(managed.nativeRoot, 'auth.json', codexAuth('gugu-a', 'a-rotated-again'));
  expect(await fileHash(old.nativeRoot, 'auth.json')).toBe(terminalBefore);
});
it('requires a fresh Codex OAuth sign-in even when the verified terminal account is already restored', async () => {
  const dir = await root(), old = codexPaths(dir), ids = ['native', 'gugu-a'];
  const terminal = codexAuth('terminal-b', 'b-current');
  const account = codexAuth('gugu-a', 'a-current');
  await put(old.nativeRoot, 'auth.json', terminal);
  await put(old.vaultRoot('gugu-a'), 'auth.json', account);
  await activateCodexAccount(old, ids, 'gugu-a', 'native');
  const restored = await restoreCodexTerminalForMigration(old, ids);
  const previous = { ...old, nativeRoot: old.vaultRoot('gugu-a') };
  const managed = { ...old, nativeRoot: join(dir, 'managed'), liveStateFile: join(dir, 'managed-live.json') };

  await expect(copyCodexUpgradeSignIn(previous, managed, 'gugu-a', 'unverified-identity')).resolves.toBe(false);
  await expect(readFile(join(managed.nativeRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(copyCodexUpgradeSignIn(previous, managed, 'gugu-a', restored.moved!.identity)).resolves.toBe(false);
  await expect(readFile(join(managed.nativeRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(previous.nativeRoot, 'auth.json'), 'utf8')).toBe(account);
  expect(await readFile(join(old.nativeRoot, 'auth.json'), 'utf8')).toBe(terminal);
});

it('keeps an unrecognized terminal Codex sign-in untouched', async () => {
  const dir = await root(), old = codexPaths(dir);
  await put(old.nativeRoot, 'auth.json', codexAuth('terminal-c', 'c-current'));
  await put(old.vaultRoot('native'), 'auth.json', codexAuth('terminal-b', 'b-current'));
  await put(old.vaultRoot('gugu-a'), 'auth.json', codexAuth('gugu-a', 'a-old'));
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'gugu-a', identity: 'wrong-identity' }));
  expect(await restoreCodexTerminalForMigration(old, ['native', 'gugu-a'])).toMatchObject({ relogin: 'gugu-a' });
  expect(await readFile(join(old.nativeRoot, 'auth.json'), 'utf8')).toBe(codexAuth('terminal-c', 'c-current'));
  expect(await readFile(join(old.vaultRoot('native'), 'auth.json'), 'utf8')).toBe(codexAuth('terminal-b', 'b-current'));
  expect(await readFile(join(old.vaultRoot('gugu-a'), 'auth.json'), 'utf8')).toBe(codexAuth('gugu-a', 'a-old'));
});
it('rolls back Codex vault and slot writes if the source changes before replacement', async () => {
  const dir = await root(), old = codexPaths(dir);
  await put(old.nativeRoot, 'auth.json', codexAuth('gugu-a', 'a-current'));
  await put(old.vaultRoot('gugu-a'), 'auth.json', codexAuth('gugu-a', 'a-old'));
  await put(old.vaultRoot('native'), 'auth.json', codexAuth('terminal-b', 'b-current'));
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'gugu-a', identity: 'chatgpt:gugu-a|fixture-workspace' }));
  const before = await readFile(join(old.vaultRoot('gugu-a'), 'auth.json'), 'utf8');
  await expect(activateCodexAccount(old, ['native', 'gugu-a'], 'native', 'gugu-a', () => new Date(), {
    allowEmptyNative: true, verifySource: async () => { throw new Error('Source changed'); },
  })).rejects.toThrow('Source changed');
  expect(await readFile(join(old.vaultRoot('gugu-a'), 'auth.json'), 'utf8')).toBe(before);
  expect(await readFile(join(old.nativeRoot, 'auth.json'), 'utf8')).toBe(codexAuth('gugu-a', 'a-current'));
});

it('retains the old Codex vault while terminal identity verification fails', async () => {
  const old = codexPaths(await root());
  const saved = codexAuth('terminal-b', 'b-current');
  await put(old.nativeRoot, 'auth.json', codexAuth('terminal-c', 'c-current'));
  await put(old.vaultRoot('native'), 'auth.json', saved);
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'native', identity: 'chatgpt:terminal-b|fixture-workspace', nativeVaultCleanup: true }));
  await expect(restoreCodexTerminalForMigration(old, ['native', 'gugu-a'])).rejects.toThrow('verify the restored Codex');
  expect(await readFile(join(old.vaultRoot('native'), 'auth.json'), 'utf8')).toBe(saved);
  const renewed = codexAuth('terminal-b', 'b-renewed');
  await put(old.nativeRoot, 'auth.json', renewed);
  await restoreCodexTerminalForMigration(old, ['native', 'gugu-a']);
  expect(await readFile(join(old.nativeRoot, 'auth.json'), 'utf8')).toBe(renewed);
  await expect(readFile(join(old.vaultRoot('native'), 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([['terminal-b', true], ['terminal-c', false]])('cleans an already-native Codex vault only when the live terminal is %s', async (terminal, matching) => {
  const old = codexPaths(await root());
  const saved = codexAuth('terminal-b', 'vault');
  await put(old.nativeRoot, 'config.toml', '# user settings');
  await put(old.nativeRoot, 'auth.json', codexAuth(terminal, 'live'));
  await put(old.vaultRoot('native'), 'auth.json', saved);
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'native', identity: 'chatgpt:terminal-b|fixture-workspace' }));
  const before = await Promise.all(['auth.json', 'config.toml'].map((file) => fileHash(old.nativeRoot, file)));

  const result = await restoreCodexTerminalForMigration(old, ['native']);

  if (matching) expect(result).not.toHaveProperty('legacyVaultUnverified');
  else expect(result).toHaveProperty('legacyVaultUnverified', true);
  expect(await Promise.all(['auth.json', 'config.toml'].map((file) => fileHash(old.nativeRoot, file)))).toEqual(before);
  const oldCredentials = readFile(join(old.vaultRoot('native'), 'auth.json'), 'utf8');
  if (matching) await expect(oldCredentials).rejects.toMatchObject({ code: 'ENOENT' });
  else await expect(oldCredentials).resolves.toBe(saved);
});

function claudePaths(root: string): ClaudeAuthSlotPaths {
  return { nativeRoot: join(root, 'terminal'), nativeGlobalConfig: join(root, 'terminal/.claude.json'),
    nativeSuffixed: true, vaultRoot: (id) => join(root, 'vaults', id), backupDir: join(root, 'backup'),
    liveStateFile: join(root, 'old-live.json'), store: createClaudeCredentialStore({ platform: 'linux' }), lockRetries: 0 };
}
async function claudeSignIn(path: string, id: string, refresh: string, expiresAt = 1) {
  await put(path, '.credentials.json', JSON.stringify({ claudeAiOauth: { refreshToken: refresh, expiresAt }, mcpLogin: 'fixture-mcp' }));
  await put(path, '.claude.json', JSON.stringify({ oauthAccount: { accountUuid: id }, hasCompletedOnboarding: true, mcpServers: { terminal: { command: 'true' } } }));
}
it('moves only the owned Claude OAuth account and preserves the terminal account and MCP sign-ins', async () => {
  const dir = await root(), old = claudePaths(dir), ids = ['native', 'gugu-a'];
  await claudeSignIn(old.nativeRoot, 'terminal-b', 'b-current');
  await claudeSignIn(old.vaultRoot('gugu-a'), 'gugu-a', 'a-old');
  await activateClaudeAccount(old, ids, 'gugu-a', 'native');
  await claudeSignIn(old.nativeRoot, 'gugu-a', 'a-rotated', 10);
  await restoreClaudeTerminalForMigration(old, ids);
  const managed = { ...old, nativeRoot: join(dir, 'managed'), nativeGlobalConfig: join(dir, 'managed/.claude.json'),
    liveStateFile: join(dir, 'managed-live.json'),
    vaultRoot: (id: string) => id === 'native' ? join(dir, 'managed-native') : old.vaultRoot(id) };
  await activateClaudeAccount(managed, ids, 'gugu-a', 'native');
  const terminal = JSON.parse(await readFile(join(old.nativeRoot, '.credentials.json'), 'utf8'));
  expect(terminal.claudeAiOauth.refreshToken).toBe('b-current');
  expect(terminal.mcpLogin).toBe('fixture-mcp');
  expect(JSON.parse(await readFile(old.nativeGlobalConfig, 'utf8')).oauthAccount.accountUuid).toBe('terminal-b');
  expect(JSON.parse(await readFile(join(managed.nativeRoot, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('a-rotated');
  expect(JSON.parse(await readFile(join(old.vaultRoot('native'), '.credentials.json'), 'utf8'))).not.toHaveProperty('claudeAiOauth');
  expect(JSON.parse(await readFile(join(old.vaultRoot('native'), '.claude.json'), 'utf8'))).not.toHaveProperty('oauthAccount');
  await expect(activateClaudeAccount(managed, ids, 'native', 'gugu-a')).rejects.toThrow('no saved sign-in');
  const managedBefore = await fileHash(managed.nativeRoot, '.credentials.json');
  await claudeSignIn(old.nativeRoot, 'terminal-b', 'b-refreshed', 20);
  expect(await fileHash(managed.nativeRoot, '.credentials.json')).toBe(managedBefore);
  const terminalBefore = await fileHash(old.nativeRoot, '.credentials.json');
  await claudeSignIn(managed.nativeRoot, 'gugu-a', 'a-rotated-again', 30);
  expect(await fileHash(old.nativeRoot, '.credentials.json')).toBe(terminalBefore);
});

it('retains the old Claude vault while terminal identity verification fails', async () => {
  const old = claudePaths(await root());
  const legacy = old.vaultRoot('native');
  await claudeSignIn(old.nativeRoot, 'terminal-c', 'c-current');
  await claudeSignIn(legacy, 'terminal-b', 'b-current');
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'native', identity: 'terminal-b', nativeVaultCleanup: true }));
  const saved = await fileHash(legacy, '.credentials.json');
  await expect(restoreClaudeTerminalForMigration(old, ['native', 'gugu-a'])).rejects.toThrow('verify the restored Claude');
  expect(await fileHash(legacy, '.credentials.json')).toBe(saved);
  await claudeSignIn(old.nativeRoot, 'terminal-b', 'b-renewed');
  const renewed = await fileHash(old.nativeRoot, '.credentials.json');
  await restoreClaudeTerminalForMigration(old, ['native', 'gugu-a']);
  expect(await fileHash(old.nativeRoot, '.credentials.json')).toBe(renewed);
  expect(JSON.parse(await readFile(join(legacy, '.credentials.json'), 'utf8'))).toEqual({ mcpLogin: 'fixture-mcp' });
});

it.each([['terminal-b', true], ['terminal-c', false]])('cleans an already-native Claude vault only when the live terminal is %s', async (terminal, matching) => {
  const old = claudePaths(await root());
  const legacy = old.vaultRoot('native');
  await claudeSignIn(old.nativeRoot, terminal, 'live');
  await claudeSignIn(legacy, 'terminal-b', 'vault');
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'native', identity: 'terminal-b' }));
  const configFiles = ['.credentials.json', '.claude.json'];
  const before = await Promise.all(configFiles.map((file) => fileHash(old.nativeRoot, file)));
  const legacyBefore = await Promise.all(configFiles.map((file) => fileHash(legacy, file)));

  const result = await restoreClaudeTerminalForMigration(old, ['native']);

  if (matching) expect(result).not.toHaveProperty('legacyVaultUnverified');
  else expect(result).toHaveProperty('legacyVaultUnverified', true);
  expect(await Promise.all(configFiles.map((file) => fileHash(old.nativeRoot, file)))).toEqual(before);
  if (matching) {
    expect(JSON.parse(await readFile(join(legacy, '.credentials.json'), 'utf8'))).toEqual({ mcpLogin: 'fixture-mcp' });
    expect(JSON.parse(await readFile(join(legacy, '.claude.json'), 'utf8'))).not.toHaveProperty('oauthAccount');
  } else expect(await Promise.all(configFiles.map((file) => fileHash(legacy, file)))).toEqual(legacyBefore);
});

it('handles an originally signed-out Codex terminal and does not restore the terminal twice on retry', async () => {
  const dir = await root(), old = codexPaths(dir), ids = ['native', 'gugu-a'];
  const latest = codexAuth('gugu-a', 'a-current');
  await put(old.nativeRoot, 'auth.json', latest);
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'gugu-a', identity: codexAuthIdentity(JSON.parse(latest)) }));
  expect(await restoreCodexTerminalForMigration(old, ids)).toMatchObject({ terminalNeedsSignIn: true, relogin: null, moved: { connectionId: 'gugu-a' } });
  await expect(readFile(join(old.nativeRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(old.vaultRoot('gugu-a'), 'auth.json'), 'utf8')).toBe(latest);
  expect(await restoreCodexTerminalForMigration(old, ids)).toEqual({ terminalNeedsSignIn: true, relogin: null });
});

it('keeps the latest owned Claude sign-in when the terminal had no native account', async () => {
  const dir = await root(), old = claudePaths(dir), ids = ['native', 'gugu-a'];
  await claudeSignIn(old.nativeRoot, 'gugu-a', 'a-current', 10);
  await writeFile(old.liveStateFile, JSON.stringify({ connectionId: 'gugu-a', identity: 'gugu-a' }));
  expect(await restoreClaudeTerminalForMigration(old, ids)).toMatchObject({ terminalNeedsSignIn: true, relogin: null, moved: { connectionId: 'gugu-a' } });
  expect(JSON.parse(await readFile(join(old.nativeRoot, '.credentials.json'), 'utf8'))).toEqual({ mcpLogin: 'fixture-mcp' });
  expect(JSON.parse(await readFile(join(old.vaultRoot('gugu-a'), '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('a-current');
  expect(await restoreClaudeTerminalForMigration(old, ids)).toEqual({ terminalNeedsSignIn: true, relogin: null });
});
