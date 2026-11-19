import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, truncate, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { ensureAgentHome, resolveAgentHome } from './agent-home';
import { AGENT_HOME_MARKER, copyAgentHomeHistory, diffAgentHome, importAgentHome, readAgentHomeMarker, reimportAgentHome, scanAgentHome } from './agent-home-import';
import type { AgentConfigRoot } from '../capabilities/session-bundle';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extraSettings: string[] = [], userPath = '.test') {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-import-'));
  roots.push(root);
  const spec: AgentConfigRoot = {
    envVar: 'TEST_HOME', userPath, evidence: 'Fixture CLI configuration root.',
    carryExclusions: [{ path: 'sessions', evidence: 'Session history is separate.' }],
    credentialPaths: [{ path: 'secret-store', evidence: 'Fixture credential store.' }],
    importGroups: [
      { id: 'settings', paths: [{ path: 'settings.json', omitKeys: ['hooks'] }, 'config.toml', ...extraSettings], evidence: 'Fixture settings.' },
      { id: 'hooks', paths: [{ path: 'settings.json', keys: ['hooks'] }], evidence: 'Fixture hooks.' },
      { id: 'mcp', paths: [{ path: '../.global.json', keys: ['mcpServers'], target: '.global.json' }], evidence: 'Fixture sibling MCP source.' },
      { id: 'rules', paths: ['RULES.md', 'AGENTS.md', 'rules/'], evidence: 'Fixture rules.' },
      { id: 'skills', paths: ['skills/'], evidence: 'Fixture skills.' },
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

it('runs unmarked homes as fresh and imports projections without copying credentials', async () => {
  const { home, source } = await fixture();
  await source('settings.json', '{"theme":"dark","hooks":{"Stop":[{"command":"mine"}]}}');
  await source('../.global.json', '{"mcpServers":{"example":{"command":"echo"}},"oauthAccount":{"id":"private"}}');
  await source('RULES.md', 'rules');
  for (const path of ['auth.json', '.credentials.json', '.env.local', 'cookie-store', 'secret-store/x', 'state.sqlite-wal', 'sessions/old.jsonl']) await source(path, 'never import');
  expect(await ensureAgentHome(home)).toBe('already-present');
  expect(await readAgentHomeMarker(home)).toBeNull();
  await expect(readFile(join(home.configRoot, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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

it('keeps the old target and writes no sign-in when the staged marker cannot be committed', async () => {
  const { home, source } = await fixture();
  await source('config.toml', 'model = "fixture"');
  await source('auth.json', 'terminal sign-in');
  await source('sessions/old.jsonl', 'old transcript');
  await ensureAgentHome(home);
  const existing = join(home.configRoot, 'local-only');
  await writeFile(existing, 'managed state');
  const afterCommit = vi.fn(async () => {
    await writeFile(join(home.configRoot, 'auth.json'), 'copied sign-in');
  });
  const renameFile = fs.rename.bind(fs);
  const markerFailure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(AGENT_HOME_MARKER)) throw Object.assign(new Error('Marker write failed'), { code: 'EACCES' });
    await renameFile(from, to);
  });

  await expect(importAgentHome(home, {
    groups: new Set(['settings']), migratedFrom: 'shared', historyPaths: ['sessions'], afterCommit,
  })).rejects.toMatchObject({ stage: 'marker', cause: { code: 'EACCES' } });
  expect(markerFailure.mock.calls.some(([, to]) => String(to).includes('.gugu-upgrade-'))).toBe(true);
  expect(afterCommit).not.toHaveBeenCalled();
  expect(await readFile(existing, 'utf8')).toBe('managed state');
  expect(await readFile(join(home.userConfigRoot, 'auth.json'), 'utf8')).toBe('terminal sign-in');
  for (const path of ['auth.json', 'config.toml', 'sessions/old.jsonl']) {
    await expect(readFile(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readAgentHomeMarker(home)).toBeNull();
  expect(await fs.readdir(dirname(home.shadowHome))).toEqual(['fixture']);
});

it('publishes the committed managed home before transferring sign-in', async () => {
  const { home, source } = await fixture();
  await source('config.toml', 'model = "fixture"');
  await ensureAgentHome(home);
  await writeFile(join(home.configRoot, 'local-only'), 'managed state');
  const afterCommit = vi.fn(async () => {
    expect(await readAgentHomeMarker(home)).toMatchObject({ migratedFrom: 'shared' });
    expect(await readFile(join(home.configRoot, 'config.toml'), 'utf8')).toBe('model = "fixture"');
    await writeFile(join(home.configRoot, 'auth.json'), 'copied sign-in');
    return { upgradeSignIn: 'copied' as const };
  });
  await expect(importAgentHome(home, { groups: new Set(['settings']), migratedFrom: 'shared', afterCommit }))
    .resolves.toMatchObject({ marker: { upgradeSignIn: 'copied' } });
  expect(afterCommit).toHaveBeenCalledOnce();
  expect(await readFile(join(home.configRoot, 'local-only'), 'utf8')).toBe('managed state');
  expect(await readFile(join(home.configRoot, 'auth.json'), 'utf8')).toBe('copied sign-in');
});

it('combines first-import settings with unrelated defaults already initialized by the CLI', async () => {
  const { home, source } = await fixture();
  await source('settings.json', '{"theme":"terminal","hooks":{"Stop":[]}}');
  await mkdir(home.configRoot, { recursive: true });
  await writeFile(join(home.configRoot, 'settings.json'), '{"runtimeDefault":true}');

  await importAgentHome(home, { groups: new Set(['settings']) });
  expect(JSON.parse(await readFile(join(home.configRoot, 'settings.json'), 'utf8'))).toEqual({
    theme: 'terminal', runtimeDefault: true,
  });
});

it('requires an explicit conflict decision after Skip', async () => {
  const { home, source } = await fixture();
  await source('settings.json', '{"theme":"terminal","hooks":{"Stop":[]}}');
  const skipped = await importAgentHome(home, { groups: new Set(), skip: true });
  expect(skipped.marker).toMatchObject({ groups: [], skipped: true });
  await writeFile(join(home.configRoot, 'settings.json'), '{"theme":"generated","hooks":{"Stop":[{"command":"managed"}]}}');

  await expect(importAgentHome(home, { groups: new Set(['settings']) })).rejects.toThrow('Managed configuration already differs');
  expect(await readAgentHomeMarker(home)).toMatchObject({ groups: [], skipped: true });
  const entry = (await diffAgentHome(home)).entries.find((item) => item.group === 'settings')!;
  expect(entry.state).toBe('bothChanged');
  expect(await readFile(join(home.configRoot, 'settings.json'), 'utf8')).toContain('generated');
  await reimportAgentHome(home, new Set([entry.id]), new Map([[entry.id, entry.revision]]));
  expect(await readAgentHomeMarker(home)).toMatchObject({ groups: ['settings'] });
  expect((await readAgentHomeMarker(home))?.skipped).toBeUndefined();
  expect(JSON.parse(await readFile(join(home.configRoot, 'settings.json'), 'utf8'))).toEqual({
    theme: 'terminal', hooks: { Stop: [{ command: 'managed' }] },
  });
  expect(JSON.parse(await readFile(join(home.userConfigRoot, 'settings.json'), 'utf8'))).toEqual({
    theme: 'terminal', hooks: { Stop: [] },
  });
});

it('requires a decision for different managed content in a previously unticked group', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'terminal rules');
  await source('settings.json', '{"theme":"dark","hooks":{"Stop":[{"command":"terminal"}]}}');
  await importAgentHome(home, { groups: new Set(['settings']) });
  await writeFile(join(home.configRoot, 'RULES.md'), 'managed rules');
  await writeFile(join(home.configRoot, 'settings.json'), '{"theme":"dark","hooks":{"Stop":[{"command":"managed"}]}}');
  const { entries } = await diffAgentHome(home);
  expect(entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'RULES.md', state: 'bothChanged' }),
    expect.objectContaining({ group: 'hooks', state: 'bothChanged' }),
  ]));
  await reimportAgentHome(home, new Set());
  expect(await readFile(join(home.configRoot, 'RULES.md'), 'utf8')).toBe('managed rules');
  expect(await readFile(join(home.configRoot, 'settings.json'), 'utf8')).toContain('managed');
});

it('follows the selected source root and its HOME boundary while refusing links inside the root', async () => {
  const { home, root, source } = await fixture(['inner-link']);
  await source('RULES.md', 'local rules');
  await source('sessions/old.jsonl', 'existing task');
  await source('../.global.json', '{"mcpServers":{"local":{"command":"echo"}}}');
  const realHome = join(root, 'physical-home');
  await rename(dirname(home.userConfigRoot), realHome);
  await symlink(realHome, dirname(home.userConfigRoot), 'dir');
  const dotfiles = join(root, 'dotfiles-root');
  await rename(home.userConfigRoot, dotfiles);
  await symlink(dotfiles, home.userConfigRoot, 'dir');
  await symlink(join(dotfiles, 'RULES.md'), join(dotfiles, 'inner-link'));
  const imported = await importAgentHome(home, { groups: new Set(['settings', 'rules', 'mcp']), historyPaths: ['sessions'] });
  expect(imported.issues).not.toContainEqual({ path: 'inner-link', reason: 'symlink' });
  expect(await fs.readlink(join(home.configRoot, 'inner-link'))).toBe(join(dotfiles, 'RULES.md'));
  expect(await readFile(join(home.configRoot, 'RULES.md'), 'utf8')).toBe('local rules');
  expect(await readFile(join(home.configRoot, 'sessions/old.jsonl'), 'utf8')).toBe('existing task');
  expect(await readFile(join(home.configRoot, '.global.json'), 'utf8')).toContain('"local"');
});

it('copies declared TOML byte for byte and leaves no marker for a malformed declaration', async () => {
  const { home, source } = await fixture();
  await source('config.toml', '[projects\n');
  await expect(importAgentHome(home, { groups: new Set(['settings']) })).rejects.toThrow('Cannot read declared configuration file config.toml');
  expect(await readAgentHomeMarker(home)).toBeNull();
  const config = '# Preserve this comment\nmodel  = "local"\n\n[projects."/first"]\ntrust_level = "trusted"\n[projects."/second"]\ntrust_level = "untrusted"\n';
  await source('config.toml', config);
  await importAgentHome(home, { groups: new Set(['settings']) });
  expect(await readFile(join(home.configRoot, 'config.toml'), 'utf8')).toBe(config);
  expect((await diffAgentHome(home)).entries).toContainEqual(expect.objectContaining({ path: 'config.toml', state: 'unchanged' }));
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

it('skips declared symlinks and oversized files and reports each skipped source', async () => {
  const { root, home, source } = await fixture(['normal.txt', 'link', 'directory-link', 'large']);
  await source('normal.txt', 'normal');
  await writeFile(join(root, 'outside'), 'private');
  await symlink(join(root, 'outside'), join(home.userConfigRoot, 'link'));
  await symlink(root, join(home.userConfigRoot, 'directory-link'));
  await source('large', '');
  await truncate(join(home.userConfigRoot, 'large'), 50 * 1024 * 1024 + 1);
  const result = await importAgentHome(home, { groups: new Set(['settings']) });
  expect(result.issues).toEqual(expect.arrayContaining([
    { path: 'directory-link', reason: 'symlink' }, { path: 'large', reason: 'tooLarge' },
  ]));
  expect(await fs.readlink(join(home.configRoot, 'link'))).toBe(join(root, 'outside'));
});

it('distinguishes six states and never deletes a managed file or overwrites an unselected conflict', async () => {
  const { home, source } = await fixture(['unchanged', 'userChanged', 'guguChanged', 'bothChanged', 'userDeleted', 'userAdded']);
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
  const { home, source } = await fixture(['private-script']);
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
  const sourceFile = await realpath(join(home.userConfigRoot, 'RULES.md'));
  const original = fs.open.bind(fs);
  let exercised = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (args[0] === sourceFile) {
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

it('streams old transcripts above the configuration-file cap and keeps copies already present', async () => {
  const { home, source } = await fixture();
  await source('sessions/large.jsonl', '');
  const size = 50 * 1024 * 1024 + 1;
  await truncate(join(home.userConfigRoot, 'sessions/large.jsonl'), size);
  await importAgentHome(home, { groups: new Set(), historyPaths: ['sessions'] });
  expect((await stat(join(home.configRoot, 'sessions/large.jsonl'))).size).toBe(size);
  await truncate(join(home.userConfigRoot, 'sessions/large.jsonl'), 2 * 1024 * 1024 * 1024 + 1);
  expect(await copyAgentHomeHistory(home, ['sessions'])).toEqual([{ path: 'sessions/large.jsonl', reason: 'sourceChanged' }]);
  expect((await stat(join(home.configRoot, 'sessions/large.jsonl'))).size).toBe(size);
});


it('walks only declared configuration and transcript paths in a populated Codex home over 2 GiB', async () => {
  const { home, source } = await fixture([], '.codex');
  await source('config.toml', 'model = "fixture"\n[mcp_servers.example]\ncommand = "echo"\n');
  await source('AGENTS.md', 'fixture instructions');
  await source('rules/default.rules', 'fixture rules');
  await source('skills/example/SKILL.md', 'fixture skill');
  await source('sessions/2026/11/19/rollout.jsonl', 'current transcript');
  await source('archived_sessions/rollout-old.jsonl', 'archived transcript');
  const program = 'plugins/.plugin-appserver/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  await source(program, '');
  await truncate(join(home.userConfigRoot, program), 2 * 1024 * 1024 * 1024 + 2);
  await source('plugins/cache/browser/payload', 'module cache');
  await source('visualizations/task/desktop.png', 'task output');
  const sourceRoot = await realpath(home.userConfigRoot);
  const listing = vi.spyOn(fs, 'readdir');
  const scanned = await scanAgentHome(home);
  expect(scanned.issues).toEqual([]);
  expect(scanned.groups.find((group) => group.id === 'settings')?.count).toBe(1);
  expect(scanned.mcpNames).toEqual(['example']);
  const imported = await importAgentHome(home, {
    groups: new Set(['settings', 'rules', 'skills']), migratedFrom: 'shared',
    historyPaths: ['sessions', 'archived_sessions'],
  });
  expect(imported.issues).toEqual([]);
  expect(Object.keys(imported.marker.files)).toEqual(['AGENTS.md', 'config.toml', 'rules/default.rules', 'skills/example/SKILL.md']);
  for (const dir of ['', 'plugins', 'visualizations']) {
    expect(listing.mock.calls.some(([path]) => String(path) === join(sourceRoot, dir))).toBe(false);
  }
  for (const dir of ['plugins', 'visualizations']) {
    await expect(stat(join(home.configRoot, dir))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await readFile(join(home.configRoot, 'sessions/2026/11/19/rollout.jsonl'), 'utf8')).toBe('current transcript');
  expect(await readFile(join(home.configRoot, 'archived_sessions/rollout-old.jsonl'), 'utf8')).toBe('archived transcript');
});

it('defers before copying when the full migration and reserve do not fit, then retries without a marker', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'rules');
  const afterCommit = vi.fn();
  const space = vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 1, bsize: 1 } as never);
  await expect(importAgentHome(home, { groups: new Set(['rules']), migratedFrom: 'shared', afterCommit }))
    .rejects.toMatchObject({ cause: { code: 'AGENT_HOME_INSUFFICIENT_SPACE', space: { shortfallBytes: 2 * 1024 ** 3 + 4 } } });
  expect(afterCommit).not.toHaveBeenCalled();
  expect(await readAgentHomeMarker(home)).toBeNull();
  await expect(stat(home.shadowHome)).rejects.toMatchObject({ code: 'ENOENT' });
  space.mockRestore();
  await importAgentHome(home, { groups: new Set(['rules']), migratedFrom: 'shared' });
  expect(await readFile(join(home.configRoot, 'RULES.md'), 'utf8')).toBe('rules');
});

it('reserves all providers together and uses ten percent when it exceeds two GiB', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'x'.repeat(100));
  const reserve = 2 * 1024 ** 3;
  const available = vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: reserve + 150, bsize: 1 } as never);
  const { checkAgentHomeImportSpace } = await import('./agent-home-migration');
  const other = { ...home, providerId: 'other', shadowHome: home.shadowHome + '-other', configRoot: home.configRoot + '-other' };
  await expect(checkAgentHomeImportSpace([home, other].map((home) => ({ home, groups: new Set(['rules'] as const) }))))
    .rejects.toMatchObject({ space: { requiredBytes: reserve + 200, shortfallBytes: 50 } });
  await source('RULES.md', '');
  await truncate(join(home.userConfigRoot, 'RULES.md'), 25 * 1024 ** 3);
  const total = 25 * 1024 ** 3;
  available.mockResolvedValue({ bavail: total, bsize: 1 } as never);
  await expect(checkAgentHomeImportSpace([{ home, groups: new Set(['rules']) }]))
    .rejects.toMatchObject({ space: { requiredBytes: total + Math.ceil(total * 0.1) } });
});

it('rolls back the whole staged home on a mid-history ENOSPC and never transfers sign-in', async () => {
  const { home, source } = await fixture();
  await source('RULES.md', 'new rules');
  await source('sessions/old.jsonl', 'old session');
  await ensureAgentHome(home);
  await writeFile(join(home.configRoot, 'local-only'), 'keep');
  const open = fs.open.bind(fs), afterCommit = vi.fn();
  let partialWrite = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('.gugu-upgrade-') && String(args[0]).endsWith('/sessions/old.jsonl') && args[1] === 'wx') {
      await handle.write(Buffer.from('part'));
      partialWrite = true;
      vi.spyOn(handle, 'write').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    }
    return handle;
  });
  await expect(importAgentHome(home, { groups: new Set(['rules']), migratedFrom: 'shared', historyPaths: ['sessions'], afterCommit }))
    .rejects.toMatchObject({ stage: 'history', cause: { code: 'ENOSPC' } });
  expect(partialWrite).toBe(true);
  expect(afterCommit).not.toHaveBeenCalled();
  expect(await readAgentHomeMarker(home)).toBeNull();
  expect(await readFile(join(home.configRoot, 'local-only'), 'utf8')).toBe('keep');
  await expect(stat(join(home.configRoot, 'RULES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(dirname(home.shadowHome))).toEqual(['fixture']);
});

it('preserves internal and external links, refuses cycles, and copies token/cookie skill assets completely', async () => {
  const { home, source } = await fixture();
  const external = join(dirname(home.userConfigRoot), '.agents/skills/find-skills');
  await mkdir(external, { recursive: true });
  await writeFile(join(external, 'SKILL.md'), 'external skill');
  const paths = ['skills/movie/SKILL.md', 'skills/movie/node_modules/playwright-core/cssTokenizer.js',
    'skills/movie/node_modules/playwright-core/cookieStore.js', 'skills/movie/node_modules/playwright-core/cookies.js',
    'skills/movie/.venv/lib/module.py', 'rules/tokens.json',
    ...Array.from({ length: 23 }, (_, n) => 'skills/theming-components/tokens/token-' + n + '.json')];
  for (const path of paths) await source(path, path.endsWith('.json') ? '{}' : 'module');
  await symlink('lib', join(home.userConfigRoot, 'skills/movie/.venv/lib64'));
  await symlink('../../.agents/skills/find-skills', join(home.userConfigRoot, 'skills/find-skills'));
  await symlink('loop', join(home.userConfigRoot, 'skills/movie/loop'));
  const imported = await importAgentHome(home, { groups: new Set(['skills', 'rules']), migratedFrom: 'shared' });
  for (const path of paths) expect(await readFile(join(home.configRoot, path), 'utf8')).toBe(path.endsWith('.json') ? '{}' : 'module');
  expect(await fs.readlink(join(home.configRoot, 'skills/movie/.venv/lib64'))).toBe('lib');
  expect(await fs.readlink(join(home.configRoot, 'skills/find-skills'))).toBe(await realpath(external));
  expect(imported.issues).toEqual([{ path: 'skills/movie/loop', reason: 'symlink' }]);
  expect((await diffAgentHome(home)).entries.filter((entry) => entry.path.includes('lib64') || entry.path === 'skills/find-skills'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'unchanged' })]));
});

it('streams large files inside declared skill trees instead of omitting them by the configuration cap', async () => {
  const { home, source } = await fixture();
  const path = 'skills/example/large.data', size = 50 * 1024 * 1024 + 1;
  await source(path, '');
  await truncate(join(home.userConfigRoot, path), size);
  const result = await importAgentHome(home, { groups: new Set(['skills']), migratedFrom: 'shared' });
  expect(result.issues).toEqual([]);
  expect((await stat(join(home.configRoot, path))).size).toBe(size);
  expect((await diffAgentHome(home)).entries).toContainEqual(expect.objectContaining({ path, state: 'unchanged' }));
});
