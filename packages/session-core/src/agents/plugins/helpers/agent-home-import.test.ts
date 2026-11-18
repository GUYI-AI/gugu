import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { ensureAgentHome, resolveAgentHome } from './agent-home';
import { AgentHomeNotImported, copyAgentHomeHistory, diffAgentHome, importAgentHome, readAgentHomeMarker, reimportAgentHome, scanAgentHome } from './agent-home-import';
import type { AgentConfigRoot } from '../capabilities/session-bundle';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-import-'));
  roots.push(root);
  const spec: AgentConfigRoot = {
    envVar: 'TEST_HOME', userPath: '.test', evidence: 'Fixture CLI configuration root.',
    carryExclusions: [{ path: 'sessions', evidence: 'Session history is separate.' }],
    credentialPaths: [{ path: 'secret-store', evidence: 'Fixture credential store.' }],
    importGroups: [
      { id: 'settings', paths: [{ path: 'settings.json', omitKeys: ['hooks'] }], evidence: 'Fixture settings.' },
      { id: 'hooks', paths: [{ path: 'settings.json', keys: ['hooks'] }], evidence: 'Fixture hooks.' },
      { id: 'mcp', paths: [{ path: '../.global.json', keys: ['mcpServers'], target: '.global.json' }], evidence: 'Fixture sibling MCP source.' },
      { id: 'rules', paths: ['RULES.md'], evidence: 'Fixture rules.' },
    ],
  };
  const home = resolveAgentHome({ providerId: 'fixture', injectionMode: 'managed-config-root', configRoot: spec,
    guguHome: join(root, 'gugu'), osHomeDir: join(root, 'user'), sourceEnv: {} })!;
  await mkdir(home.userConfigRoot, { recursive: true });
  const source = async (path: string, content: string) => {
    const full = join(home.userConfigRoot, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };
  return { root, home, source };
}

it('requires explicit consent, imports projections, excludes credentials and retains source files', async () => {
  const { home, source } = await fixture();
  await source('settings.json', '{"theme":"dark","hooks":{"Stop":[{"command":"mine"}]}}');
  await source('../.global.json', '{"mcpServers":{"example":{"command":"echo"}},"oauthAccount":{"id":"private"}}');
  await source('RULES.md', 'rules');
  for (const path of ['auth.json', '.credentials.json', '.env.local', 'cookie-store', 'secret-store/x', 'state.sqlite-wal', 'sessions/old.jsonl']) await source(path, 'never import');
  await expect(ensureAgentHome(home)).rejects.toBeInstanceOf(AgentHomeNotImported);
  const result = await importAgentHome(home, { groups: new Set(['settings', 'mcp', 'rules']), now: new Date('2026-11-18T00:00:00Z') });
  expect(JSON.parse(await readFile(join(home.configRoot, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  expect(JSON.parse(await readFile(join(home.configRoot, '.global.json'), 'utf8'))).toEqual({ mcpServers: { example: { command: 'echo' } } });
  expect(result.marker.importedAt).toBe('2026-11-18T00:00:00.000Z');
  expect(Object.values(result.marker.files).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  for (const path of ['auth.json', '.credentials.json', '.env.local', 'cookie-store', 'secret-store/x', 'state.sqlite-wal', 'sessions/old.jsonl']) {
    await expect(readFile(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home.userConfigRoot, path), 'utf8')).toBe('never import');
  }
  expect(await ensureAgentHome(home)).toBe('already-present');
});

it('merges separately selected projections and keeps hook-only changes in the hooks group', async () => {
  const { home, source } = await fixture();
  await source('settings.json', '{"theme":"dark","hooks":{"Stop":[]}}');
  await importAgentHome(home, { groups: new Set(['settings', 'hooks']) });
  await source('settings.json', '{"theme":"dark","hooks":{"Stop":[{"command":"changed"}]}}');
  expect((await diffAgentHome(home)).entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ group: 'settings', state: 'unchanged' }),
    expect.objectContaining({ group: 'hooks', state: 'userChanged' }),
  ]));
  const hook = (await diffAgentHome(home)).entries.find((entry) => entry.group === 'hooks')!;
  await reimportAgentHome(home, new Set([hook.id]));
  expect(JSON.parse(await readFile(join(home.configRoot, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', hooks: { Stop: [{ command: 'changed' }] } });
});

it('skips symlinks and oversized files and reports each skipped source', async () => {
  const { root, home, source } = await fixture();
  await source('normal.txt', 'normal');
  await writeFile(join(root, 'outside'), 'private');
  await symlink(join(root, 'outside'), join(home.userConfigRoot, 'link'));
  await symlink(root, join(home.userConfigRoot, 'directory-link'));
  await source('large', '');
  await truncate(join(home.userConfigRoot, 'large'), 50 * 1024 * 1024 + 1);
  const result = await importAgentHome(home, { groups: new Set(['settings']) });
  expect(result.issues).toEqual(expect.arrayContaining([
    { path: 'link', reason: 'symlink' }, { path: 'directory-link', reason: 'symlink' }, { path: 'large', reason: 'tooLarge' },
  ]));
  await expect(readFile(join(home.configRoot, 'link'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('distinguishes six states and never deletes a managed file or overwrites an unselected conflict', async () => {
  const { home, source } = await fixture();
  for (const name of ['unchanged', 'userChanged', 'guguChanged', 'bothChanged', 'userDeleted']) await source(name, 'base');
  await importAgentHome(home, { groups: new Set(['settings']) });
  await source('userChanged', 'user');
  await source('bothChanged', 'user');
  await source('userAdded', 'new');
  await rm(join(home.userConfigRoot, 'userDeleted'));
  await writeFile(join(home.configRoot, 'guguChanged'), 'gugu');
  await writeFile(join(home.configRoot, 'bothChanged'), 'gugu');
  const diff = await diffAgentHome(home);
  for (const state of ['unchanged', 'userChanged', 'guguChanged', 'bothChanged', 'userAdded', 'userDeleted']) {
    expect(diff.entries).toContainEqual(expect.objectContaining({ id: state, path: state, group: 'settings', state }));
  }
  await reimportAgentHome(home, new Set(['userChanged', 'userAdded', 'userDeleted']));
  expect(await readFile(join(home.configRoot, 'bothChanged'), 'utf8')).toBe('gugu');
  expect(await readFile(join(home.configRoot, 'userDeleted'), 'utf8')).toBe('base');
  await reimportAgentHome(home, new Set(['bothChanged']));
  expect(await readFile(join(home.configRoot, 'bothChanged'), 'utf8')).toBe('user');
});

it('skip creates an empty root and marker without reading the user root', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'keep terminal');
  const { marker } = await importAgentHome(home, { groups: new Set() });
  expect(marker.groups).toEqual([]);
  expect(marker.files).toEqual({});
  await expect(readFile(join(home.configRoot, 'RULES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('upgrades legacy markers without asking again and treats unequal unbased content as a conflict', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'terminal');
  await mkdir(home.configRoot, { recursive: true });
  await writeFile(join(home.configRoot, 'RULES.md'), 'gugu');
  await writeFile(join(home.shadowHome, '.gugu-agent-home.json'), '{"providerId":"fixture","seed":"copied"}');
  expect(await ensureAgentHome(home)).toBe('already-present');
  expect((await readAgentHomeMarker(home))?.legacyBaseline).toBe(true);
  expect((await diffAgentHome(home)).entries).toContainEqual(expect.objectContaining({ path: 'RULES.md', state: 'bothChanged', uncertain: true }));
  expect((await scanAgentHome(home)).marker).not.toBeNull();
});

it('keeps managed roots private and does not widen source permission bits', async () => {
  const { home, source } = await fixture();
  await source('private-script', 'fixture');
  await chmod(join(home.userConfigRoot, 'private-script'), 0o750);
  await importAgentHome(home, { groups: new Set(['settings']) });
  expect((await stat(home.shadowHome)).mode & 0o777).toBe(0o700);
  expect((await stat(home.configRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(join(home.configRoot, 'private-script'))).mode & 0o777).toBe(0o750);
});

it('rejects a stale re-import decision if the managed configuration changed after the dialog opened', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'base');
  await importAgentHome(home, { groups: new Set(['rules']) });
  await source('RULES.md', 'terminal');
  const entry = (await diffAgentHome(home)).entries.find((entry) => entry.path === 'RULES.md')!;
  await writeFile(join(home.configRoot, 'RULES.md'), 'new Gugu edit');
  await expect(reimportAgentHome(home, new Set([entry.id]), new Map([[entry.id, entry.revision]]))).rejects.toThrow('review the differences');
  expect(await readFile(join(home.configRoot, 'RULES.md'), 'utf8')).toBe('new Gugu edit');
});

it('reports a source changed between stat and reading through its open handle', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'before');
  const original = fs.open.bind(fs);
  let exercised = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (args[0] === join(home.userConfigRoot, 'RULES.md')) {
      exercised = true;
      await writeFile(join(home.userConfigRoot, 'RULES.md'), 'changed while reading');
    }
    return handle;
  });
  expect((await importAgentHome(home, { groups: new Set(['rules']) })).issues)
    .toContainEqual({ path: 'RULES.md', reason: 'sourceChanged' });
  expect(exercised).toBe(true);
  await expect(stat(join(home.configRoot, 'RULES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('streams old transcripts above the configuration-file cap under the remaining root budget', async () => {
  const { home, source } = await fixture();
  await source('sessions/large.jsonl', '');
  const size = 50 * 1024 * 1024 + 1;
  await truncate(join(home.userConfigRoot, 'sessions/large.jsonl'), size);
  await importAgentHome(home, { groups: new Set(), historyPaths: ['sessions'] });
  expect((await stat(join(home.configRoot, 'sessions/large.jsonl'))).size).toBe(size);
  expect(await copyAgentHomeHistory(home, ['sessions'], 2 * 1024 * 1024 * 1024 - size + 1))
    .toContainEqual({ path: 'sessions/large.jsonl', reason: 'tooLarge' });
});
