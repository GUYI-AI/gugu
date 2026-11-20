import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { reconcileCodexNativeReference, type CodexReferenceCommit, type CodexReferenceRow } from './codex-native-auth-migration';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function auth(person: string, refresh = 'private-fixture-refresh') {
  const jwt = (value: unknown) => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ sub: person,
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } }), account_id: 'workspace', refresh_token: refresh } });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-reference-')); roots.push(root);
  const sourceRoot = join(root, 'terminal');
  const managedRoot = join(root, 'gugu-managed');
  const stateRoot = join(root, 'gugu-state');
  const vaultRoot = (id: string) => join(stateRoot, id, '.codex');
  let rows: CodexReferenceRow[] = [{ accountId: 'native', isDefault: true, updatedAt: 1, meta: { harnessConnection: { kind: 'native' } } }];
  const put = async (directory: string, value: string) => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'auth.json'), value); };
  await put(sourceRoot, auth('person'));
  const commit = vi.fn(async (value: CodexReferenceCommit) => {
    if (rows.find(row => row.accountId === 'native')?.meta?.harnessConnection?.nativeOAuth?.operationId === value.operationId) return;
    rows = rows.map(row => ({ ...row, isDefault: row.accountId === value.defaultId,
      meta: { ...row.meta, harnessConnection: { ...(row.meta?.harnessConnection ?? { kind: 'native' as const }),
        ...(row.accountId === 'native' ? { nativeOAuth: { root: value.root, identity: value.identity, operationId: value.operationId } }
          : value.aliases.includes(row.accountId) ? { removed: true, migratedTo: 'native' } : {}) } } }));
    rows.push(...value.retained.filter(item => !rows.some(row => row.accountId === item.id)).map(item => ({ accountId: item.id,
      isDefault: value.defaultId === item.id, updatedAt: 1, meta: { displayName: item.name, harnessConnection: { kind: 'account' as const } } })));
  });
  const options = { sourceRoot, managedRoot, stateRoot, vaultRoot, rows: async () => rows, commit, beforeMove: vi.fn(async () => undefined) };
  return { ...options, put, getRows: () => rows, addRow: (id: string) => rows.push({ accountId: id, isDefault: false, updatedAt: 1,
    meta: { harnessConnection: { kind: 'account' } } }), run: (checkpoint?: (stage: string) => Promise<void>) => reconcileCodexNativeReference({ ...options, checkpoint }) };
}

it('collapses copied native and named OAuth to one reference, retaining source bytes and old ID aliases across restart', async () => {
  const f = await fixture(); f.addRow('copied');
  await f.put(f.managedRoot, auth('person', 'old-copy'));
  await f.put(f.vaultRoot('copied'), auth('person', 'older-copy'));
  const source = await readFile(join(f.sourceRoot, 'auth.json'));
  expect(await f.run()).toBe(true);
  expect(f.getRows().filter(row => !row.meta?.harnessConnection?.removed)).toHaveLength(1);
  expect(f.getRows().find(row => row.accountId === 'copied')?.meta?.harnessConnection?.migratedTo).toBe('native');
  await expect(readFile(join(f.managedRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(f.vaultRoot('copied'), 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.sourceRoot, 'auth.json'))).toEqual(source);
  await f.run(); await f.run();
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.getRows().filter(row => !row.meta?.harnessConnection?.removed)).toHaveLength(1);
});

it('keeps a different managed account as a second connection without copying its OAuth', async () => {
  const f = await fixture(); const independent = auth('another-person');
  await f.put(f.managedRoot, independent);
  await f.run();
  const other = f.getRows().find(row => row.accountId !== 'native')!;
  expect(other.isDefault).toBe(true);
  expect(await readFile(join(f.vaultRoot(other.accountId), 'auth.json'), 'utf8')).toBe(independent);
  await f.run(); await f.run();
  expect(f.getRows()).toHaveLength(2);
  expect(f.commit).toHaveBeenCalledTimes(1);
});

it('keeps the live independent account once when its old inactive native vault is also present', async () => {
  const f = await fixture();
  await f.put(f.managedRoot, auth('another-person', 'live-generation'));
  await f.put(f.vaultRoot('native'), auth('another-person', 'old-inactive-generation'));
  await f.run(); await f.run();
  const other = f.getRows().find(row => row.accountId !== 'native')!;
  expect(f.getRows()).toHaveLength(2);
  expect(await readFile(join(f.vaultRoot(other.accountId), 'auth.json'), 'utf8')).toBe(auth('another-person', 'live-generation'));
});

it('reuses an existing different managed account instead of inventing a third connection', async () => {
  const f = await fixture(); f.addRow('work');
  await f.put(f.managedRoot, auth('another-person', 'live-generation'));
  await f.put(f.vaultRoot('work'), auth('another-person', 'inactive-generation'));
  await f.put(f.vaultRoot('native'), auth('another-person', 'old-native-generation'));
  await f.run(); await f.run();
  expect(f.getRows()).toHaveLength(2);
  expect(f.getRows().find(row => row.isDefault)?.accountId).toBe('work');
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(auth('another-person', 'live-generation'));
});

it('keeps the native reference visibly current when the matching managed owner already has a named row', async () => {
  const f = await fixture(); f.addRow('work');
  await f.put(f.managedRoot, auth('person', 'live-generation'));
  await f.put(f.vaultRoot('work'), auth('person', 'inactive-generation'));
  await f.run();
  expect(f.getRows().find(row => row.isDefault)?.accountId).toBe('native');
  expect(f.getRows().filter(row => !row.meta?.harnessConnection?.removed)).toHaveLength(1);
});

it('restores staged copies after a rejected registry transaction, then retries with fresh metadata', async () => {
  const f = await fixture(); await f.put(f.managedRoot, auth('person', 'old-copy'));
  f.commit.mockRejectedValueOnce(new Error('registry CAS rejected'));
  await expect(f.run()).rejects.toThrow('registry CAS rejected');
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(auth('person', 'old-copy'));
  await expect(readFile(join(f.stateRoot, 'native-oauth-reference.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await f.run(); expect(f.getRows()).toHaveLength(1);
});

it.each(['prepared', 'moved', 'committed', 'removed'])('restarts idempotently after the %s checkpoint', async stage => {
  const f = await fixture(); await f.put(f.managedRoot, auth('person', 'old-copy'));
  let interrupted = false;
  await expect(f.run(async at => { if (at === stage && !interrupted) { interrupted = true; throw new Error('simulated host exit'); } }))
    .rejects.toThrow('simulated host exit');
  const journal = await readFile(join(f.stateRoot, 'native-oauth-reference.json'), 'utf8');
  expect(journal).not.toContain('old-copy'); expect(journal).not.toContain('private-fixture-refresh');
  await f.run(); await f.run();
  expect(f.getRows().filter(row => !row.meta?.harnessConnection?.removed)).toHaveLength(1);
  expect(await readFile(join(f.sourceRoot, 'auth.json'), 'utf8')).toBe(auth('person'));
  await expect(readFile(join(f.stateRoot, 'native-oauth-reference.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects changed credentials before removal and does not commit aliases', async () => {
  const f = await fixture(); await f.put(f.managedRoot, auth('person'));
  await expect(f.run(async stage => { if (stage === 'prepared') await f.put(f.managedRoot, auth('another-person')); }))
    .rejects.toThrow('changed during migration');
  expect(f.commit).not.toHaveBeenCalled();
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(auth('another-person'));
});

it('never follows a credential symlink into the user native directory', async () => {
  const f = await fixture(); await mkdir(f.managedRoot);
  await symlink(join(f.sourceRoot, 'auth.json'), join(f.managedRoot, 'auth.json'));
  await expect(f.run()).rejects.toThrow('private regular file');
  expect(f.commit).not.toHaveBeenCalled();
  expect(await readFile(join(f.sourceRoot, 'auth.json'), 'utf8')).toBe(auth('person'));
});

it('never moves a Gugu file that is the native auth.json symlink authority', async () => {
  const f = await fixture(); await f.put(f.managedRoot, auth('person'));
  await rm(join(f.sourceRoot, 'auth.json'));
  await symlink(join(f.managedRoot, 'auth.json'), join(f.sourceRoot, 'auth.json'));
  await expect(f.run()).rejects.toThrow('cannot modify the native credential authority');
  expect(await readFile(join(f.sourceRoot, 'auth.json'), 'utf8')).toBe(auth('person'));
  expect(f.commit).not.toHaveBeenCalled();
});

it('does not reclassify a managed account left behind after selecting a native reference', async () => {
  const f = await fixture(); await f.run();
  await f.put(f.managedRoot, auth('another-person'));
  await f.run();
  expect(f.getRows()).toHaveLength(1);
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(auth('another-person'));
});

it('leaves an API-key or mixed API-key document unchanged; it is not an OAuth connection', async () => {
  const f = await fixture();
  const mixed = JSON.stringify({ ...JSON.parse(auth('person')), auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key' });
  await f.put(f.sourceRoot, mixed); await f.put(f.managedRoot, mixed);
  expect(await f.run()).toBe(false);
  expect(f.commit).not.toHaveBeenCalled();
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(mixed);
});

it('never treats a stale file under a keyring-configured native store as the authority', async () => {
  const f = await fixture(); await f.put(f.managedRoot, auth('person', 'copied'));
  await writeFile(join(f.sourceRoot, 'config.toml'), 'cli_auth_credentials_store="keyring"');
  await expect(f.run()).rejects.toThrow('keyring');
  expect(f.commit).not.toHaveBeenCalled();
  expect(await readFile(join(f.managedRoot, 'auth.json'), 'utf8')).toBe(auth('person', 'copied'));
});
