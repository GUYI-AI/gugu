import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { diffAgentHome, importAgentHome, readAgentHomeMarker, reimportAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { importCodexMemories, scanCodexMemories } from './memories';

let root: string;
let home: ResolvedAgentHome;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codex-memory-import-')));
  const shadowHome = join(root, 'managed', 'codex');
  home = {
    providerId: 'codex', envVar: 'CODEX_HOME', shadowHome, configRoot: join(shadowHome, '.codex'),
    userConfigRoot: join(root, 'user', '.codex'), osHomeDir: join(root, 'user'),
    credentialPaths: ['auth.json'], carryExclusions: [], seedFiles: [],
    importGroups: [{ id: 'rules', paths: ['AGENTS.md', 'AGENTS.override.md', 'rules/', 'prompts/', 'memories/'], evidence: 'Native rules fixture.' }],
  };
  await fs.mkdir(home.userConfigRoot, { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function source(path: string, text: string) {
  const file = join(home.userConfigRoot, path);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}
async function project(name: string) {
  const cwd = join(root, name);
  await fs.mkdir(cwd);
  await fs.writeFile(join(cwd, 'AGENTS.md'), 'Original project rule');
  return cwd;
}
const scan = () => scanCodexMemories({ home });
async function selection() {
  return (await scan()).items.filter(item => item.fingerprint).map(item => ({ localSourceId: item.localSourceId, fingerprint: item.fingerprint! }));
}

it('counts one personal bundle and four cwd-bound summaries without emitting bodies', async () => {
  await source('AGENTS.md', 'Private personal instruction body');
  await source('memories/memory_summary.md', 'Private summary body');
  await source('memories/MEMORY.md', 'Fallback must not be selected');
  const directories: string[] = [];
  for (let i = 0; i < 4; i++) {
    const cwd = await project(`project-${i}`);
    directories.push(cwd);
    await source(`memories/rollout_summaries/${i}.md`, `thread_id: ${i}\nupdated_at: 2026-11-19T08:00:00Z\ncwd: ${cwd}\n\nPrivate project memory body`);
  }
  const result = await scan();
  expect(result.count).toBe(5);
  expect(result.items[0].sourcePaths).toEqual(['AGENTS.md', 'memories/memory_summary.md']);
  expect(result.items.slice(1).map(item => item.cwd)).toEqual(directories);
  expect(result.items.every(item => item.status === 'ready')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('Private');
  expect(JSON.stringify(result)).not.toContain('Fallback');
  await expect(fs.stat(home.shadowHome)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('imports only the selected memory files through the native rules path, preserving original project rules', async () => {
  const cwd = await project('actual-project');
  const originals = {
    'AGENTS.md': 'Personal rule', 'memories/memory_summary.md': 'Personal native memory',
    'memories/rollout_summaries/project.md': `cwd: ${cwd}\nupdated_at: 2026-11-19\nProject native memory`,
  };
  for (const [path, text] of Object.entries(originals)) await source(path, text);
  await source('memories/MEMORY.md', 'Excluded fallback');
  await source('memories/raw_memories.md', 'Excluded raw memory');
  await source('rules/unrelated.md', 'Excluded rule');
  await source('auth.json', 'Excluded credential fixture');
  const selected = await selection();
  const result = await importCodexMemories({ home, selection: selected });
  expect(result.items.map(item => item.status)).toEqual(['imported', 'imported']);
  for (const [path, text] of Object.entries(originals)) {
    expect(await fs.readFile(join(home.configRoot, path), 'utf8')).toBe(text);
    expect(await fs.readFile(join(home.userConfigRoot, path), 'utf8')).toBe(text);
  }
  for (const path of ['memories/MEMORY.md', 'memories/raw_memories.md', 'rules/unrelated.md', 'auth.json']) {
    await expect(fs.stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(await fs.readFile(join(cwd, 'AGENTS.md'), 'utf8')).toBe('Original project rule');
  const marker = await readAgentHomeMarker(home);
  expect(Object.keys(marker!.files).sort()).toEqual(Object.keys(originals).sort());
  expect(marker?.groups).toEqual(['rules']);
  expect(marker?.skipped).toBeUndefined();
});

it('reuses a preexisting complete rules import without rewriting its marker', async () => {
  await source('AGENTS.md', 'Same rule');
  await source('memories/memory_summary.md', 'Same native summary');
  await importAgentHome(home, { groups: new Set(['rules']) });
  const before = await fs.readFile(join(home.shadowHome, '.gugu-agent-home.json'), 'utf8');
  expect((await scan()).items[0].status).toBe('exists');
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('exists');
  expect(await fs.readFile(join(home.shadowHome, '.gugu-agent-home.json'), 'utf8')).toBe(before);
});

it('retains unrelated imported configuration and its marker when adding only memory', async () => {
  home.importGroups = [...home.importGroups,
    { id: 'settings', paths: ['config.toml'], evidence: 'Existing settings import.' }];
  await source('config.toml', 'model="fixture-model"\n');
  await importAgentHome(home, { groups: new Set(['settings']) });
  const before = await readAgentHomeMarker(home);
  await source('AGENTS.md', 'Only this memory is selected');
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('imported');
  const after = await readAgentHomeMarker(home);
  expect(after?.files['config.toml']).toBe(before?.files['config.toml']);
  expect(after?.groups).toEqual(['settings', 'rules']);
  expect(await fs.readFile(join(home.configRoot, 'config.toml'), 'utf8')).toBe('model="fixture-model"\n');
});

it('uses MEMORY.md only when the preferred summary is absent, including an empty preferred file', async () => {
  await source('memories/MEMORY.md', 'Fallback');
  expect((await scan()).items[0].sourcePaths).toEqual(['memories/MEMORY.md']);
  await source('memories/memory_summary.md', '');
  expect((await scan()).items[0].sourcePaths).toEqual(['memories/memory_summary.md']);
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('imported');
  expect(await fs.readFile(join(home.configRoot, 'memories/memory_summary.md'), 'utf8')).toBe('');
});

it('leaves preexisting and subsequently edited managed memory untouched', async () => {
  await source('AGENTS.md', 'Source rule');
  await fs.mkdir(home.configRoot, { recursive: true });
  await fs.writeFile(join(home.configRoot, 'AGENTS.md'), 'Managed preference');
  expect((await scan()).items[0]).toMatchObject({ status: 'conflict', reason: 'target-differs' });
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('conflict');
  expect(await fs.readFile(join(home.configRoot, 'AGENTS.md'), 'utf8')).toBe('Managed preference');
});

it('rechecks a preview fingerprint before importing and keeps source changes explicit', async () => {
  await source('AGENTS.md', 'Initial source');
  const old = await selection();
  await source('AGENTS.md', 'New source');
  expect((await importCodexMemories({ home, selection: old })).items[0])
    .toMatchObject({ status: 'conflict', reason: 'source-changed' });
  await expect(fs.stat(home.configRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves target edits after an import and allows a selected source-only update', async () => {
  await source('AGENTS.md', 'Initial source');
  await importCodexMemories({ home, selection: await selection() });
  await source('AGENTS.md', 'Updated source');
  expect((await scan()).items[0].status).toBe('ready');
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('imported');
  expect(await fs.readFile(join(home.configRoot, 'AGENTS.md'), 'utf8')).toBe('Updated source');
  await fs.writeFile(join(home.configRoot, 'AGENTS.md'), 'User edited managed rule');
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('conflict');
  expect(await fs.readFile(join(home.configRoot, 'AGENTS.md'), 'utf8')).toBe('User edited managed rule');
});

it('keeps invalid and missing project cwd candidates scoped and skipped', async () => {
  const absent = join(root, 'does-not-exist');
  await source('memories/rollout_summaries/invalid.md', 'cwd: relative/path\nMust never become global');
  await source('memories/rollout_summaries/missing.md', `cwd: ${absent}\nMissing project`);
  await source('memories/rollout_summaries/no-cwd.md', 'No cwd header');
  const result = await scan();
  expect(result.count).toBe(3);
  expect(result.items.map(item => item.scope)).toEqual(['project', 'project', 'project']);
  expect(result.items.map(item => item.reason)).toEqual(['invalid-cwd', 'missing-directory', 'invalid-cwd']);
  expect((await importCodexMemories({ home, selection: await selection() })).items.every(item => item.status === 'skipped')).toBe(true);
  await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not traverse nested summaries or unrelated memory trees', async () => {
  await source('memories/rollout_summaries/nested/ignored.md', 'cwd: /ignored');
  await source('memories/rollout_summaries/ignored.txt', 'cwd: /ignored');
  await source('memories/.git/index', 'Not a memory candidate');
  expect(await scan()).toEqual({ count: 0, items: [] });
});

it('preserves safe source links and rejects links into credential locations', async () => {
  const external = join(root, 'shared-rule.md');
  await fs.writeFile(external, 'Linked user rule');
  await fs.symlink(external, join(home.userConfigRoot, 'AGENTS.md'));
  expect((await importCodexMemories({ home, selection: await selection() })).items[0].status).toBe('imported');
  expect(await fs.readlink(join(home.configRoot, 'AGENTS.md'))).toBe(external);
  await fs.rm(join(home.userConfigRoot, 'AGENTS.md'));
  const secret = join(home.osHomeDir, '.ssh', 'secret-fixture');
  await fs.mkdir(dirname(secret), { recursive: true });
  await fs.writeFile(secret, 'Never read this fixture');
  await fs.symlink(secret, join(home.userConfigRoot, 'AGENTS.md'));
  expect((await scan()).items[0]).toMatchObject({ status: 'skipped', reason: 'sensitive-link' });
});

it('rejects managed/source aliasing before any write', async () => {
  await source('AGENTS.md', 'Do not change');
  await expect(scanCodexMemories({ home: { ...home, configRoot: home.userConfigRoot, shadowHome: home.osHomeDir } }))
    .rejects.toThrow('separate from their source');
  expect(await fs.readFile(join(home.userConfigRoot, 'AGENTS.md'), 'utf8')).toBe('Do not change');
});

it('is idempotent for repeated and concurrent selections', async () => {
  await source('AGENTS.md', 'One copy');
  const selected = await selection();
  const result = await Promise.all([importCodexMemories({ home, selection: selected }), importCodexMemories({ home, selection: selected })]);
  expect(result.flatMap(result => result.items.map(item => item.status)).sort()).toEqual(['exists', 'imported']);
  expect((await importCodexMemories({ home, selection: selected })).items[0].status).toBe('exists');
});

it('propagates the caller cancellation reason from scan, diff and reimport', async () => {
  await source('AGENTS.md', 'Source');
  const controller = new AbortController();
  const cancellation = new Error('Original cancellation reason');
  controller.abort(cancellation);
  await expect(scanCodexMemories({ home, signal: controller.signal })).rejects.toBe(cancellation);
  await expect(importCodexMemories({ home, selection: [], signal: controller.signal })).rejects.toBe(cancellation);
  await expect(diffAgentHome(home, controller.signal)).rejects.toBe(cancellation);
  await expect(reimportAgentHome(home, new Set(), undefined, controller.signal)).rejects.toBe(cancellation);
});

it('records already published files when cancelled, then resumes without overwriting other rules', async () => {
  await source('AGENTS.md', 'First complete file');
  await source('memories/memory_summary.md', 'Second complete file');
  const selected = await selection();
  const controller = new AbortController();
  const cancellation = new Error('Cancel after first publication');
  const original = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    await original(...args);
    if (String(args[0]) === join(home.configRoot, 'AGENTS.md')) controller.abort(cancellation);
  });
  await expect(importCodexMemories({ home, selection: selected, signal: controller.signal })).rejects.toBe(cancellation);
  const marker = await readAgentHomeMarker(home);
  expect(marker?.files['AGENTS.md']).toBe(hash('First complete file'));
  expect(marker?.files['memories/memory_summary.md']).toBeUndefined();
  expect(await fs.readFile(join(home.configRoot, 'AGENTS.md'), 'utf8')).toBe('First complete file');
  vi.restoreAllMocks();
  expect((await importCodexMemories({ home, selection: selected })).items[0].status).toBe('imported');
  expect(await fs.readFile(join(home.configRoot, 'memories/memory_summary.md'), 'utf8')).toBe('Second complete file');
  const files = await fs.readdir(home.configRoot);
  expect(files).toEqual(['AGENTS.md', 'memories']);
});
