import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveAgentHome, streamImportFile } from '@gugu/session-core/agents/plugins/helpers';
import { importCodexSkills, scanCodexSkills, type CodexSkillItem } from './skills';

const fixtures: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of fixtures.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'codex-skill-import-'));
  fixtures.push(root);
  const home = resolveAgentHome({
    providerId: 'codex', injectionMode: 'managed-config-root', guguHome: join(root, 'gugu'),
    osHomeDir: join(root, 'user'), sourceEnv: {},
    configRoot: { envVar: 'CODEX_HOME', userPath: '.codex', evidence: 'Fixture native root.',
      carryExclusions: [],
      credentialPaths: [{ path: 'auth.json', evidence: 'Fixture credential store.' }],
      importGroups: [{ id: 'skills', paths: ['skills/'], evidence: 'Fixture skills.' }] },
  })!;
  const codex = join(home.userConfigRoot, 'skills');
  const agents = join(home.osHomeDir, '.agents', 'skills');
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(agents, { recursive: true });
  const write = async (path: string, text: string, mode?: number) => {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, text, { mode });
  };
  const skill = async (base: string, folder: string, name = folder) => {
    const path = join(base, folder);
    await write(join(path, 'SKILL.md'), '---\nname: ' + name + '\ndescription: "Use for ' + name + '"\n---\nPrivate instructions stay in files.\n');
    return path;
  };
  return { root, home, codex, agents, write, skill };
}
const selection = (items: CodexSkillItem[]) => items.flatMap(({ localSourceId, fingerprint }) =>
  fingerprint ? [{ localSourceId, fingerprint }] : []);

it('finds 115 custom skills from 85 + 32 - 2 aliases, excluding built-ins and plugin cache trees', async () => {
  const f = await fixture();
  for (let i = 0; i < 83; i++) await f.skill(f.codex, 'codex-' + i);
  for (let i = 0; i < 32; i++) await f.skill(f.agents, 'agents-' + i);
  await fs.symlink('../../.agents/skills/agents-0', join(f.codex, 'alias-a'), 'dir');
  await fs.symlink('../../.agents/skills/agents-1', join(f.codex, 'alias-b'), 'dir');
  for (let i = 0; i < 5; i++) await f.skill(join(f.codex, '.system'), 'builtin-' + i);
  for (let i = 0; i < 157; i++) await f.skill(join(f.home.userConfigRoot, 'plugins', 'cache', 'plugin', 'skills'), 'plugin-' + i);
  const scan = await scanCodexSkills({ home: f.home });
  expect(scan.counts).toEqual({ codex: 85, agents: 32, duplicates: 2, custom: 115 });
  expect(scan.items).toHaveLength(115);
  expect(scan.items.every(({ status }) => status === 'ready')).toBe(true);
  expect(scan.items.filter(({ aliases }) => aliases.length === 2)).toHaveLength(2);
  expect(JSON.stringify(scan)).not.toContain('Private instructions stay in files');
  expect(scan.excludedRoots.map(({ reason }) => reason)).toEqual(['built-in', 'plugin-cache']);
});

it('publishes complete native skill trees, preserves links/modes/assets, and leaves the home marker and source intact', async () => {
  const f = await fixture();
  const source = await f.skill(f.codex, 'full');
  await f.write(join(source, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  await f.write(join(source, 'references', 'token.json'), '{"fixture":"ordinary asset"}');
  await f.write(join(source, 'assets', 'cookie.txt'), 'ordinary asset');
  await fs.mkdir(join(source, 'assets', 'empty'), { recursive: true });
  await fs.symlink('../references/token.json', join(source, 'assets', 'internal'));
  await f.write(join(f.home.osHomeDir, 'external.txt'), 'external');
  await fs.symlink('../../../external.txt', join(source, 'external'));
  await fs.symlink('missing.txt', join(source, 'dangling'));
  await f.write(join(f.home.shadowHome, '.gugu-agent-home.json'), '{"sourceRoot":"original-home-marker"}');
  const before = await scanCodexSkills({ home: f.home });
  const sourceHash = await streamImportFile(join(source, 'SKILL.md'));
  const result = await importCodexSkills({ home: f.home, selection: selection(before.items) });
  expect(result.items[0]!.status).toBe('imported');
  const target = result.items[0]!.target;
  expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(join(target, 'references', 'token.json'), 'utf8')).toBe('{"fixture":"ordinary asset"}');
  expect((await fs.stat(join(target, 'scripts', 'run.sh'))).mode & 0o777).toBe(0o755);
  expect((await fs.stat(join(target, 'assets', 'empty'))).isDirectory()).toBe(true);
  expect(await fs.readlink(join(target, 'assets', 'internal'))).toBe('../references/token.json');
  expect(await fs.readlink(join(target, 'external'))).toBe(join(f.home.osHomeDir, 'external.txt'));
  expect(await fs.readlink(join(target, 'dangling'))).toBe('missing.txt');
  expect(await fs.readFile(join(f.home.shadowHome, '.gugu-agent-home.json'), 'utf8')).toBe('{"sourceRoot":"original-home-marker"}');
  expect(await streamImportFile(join(source, 'SKILL.md'))).toBe(sourceHash);
  const after = await scanCodexSkills({ home: f.home });
  expect(after.items[0]).toMatchObject({ status: 'exists', fingerprint: before.items[0]!.fingerprint,
    resources: { hasScripts: true, externalLinks: 1 } });
  expect((await importCodexSkills({ home: f.home, selection: selection(before.items) })).items[0]!.status).toBe('exists');
});

it('preserves large skill bodies and streams large top-level resources through the migration primitive', async () => {
  const f = await fixture();
  const source = await f.skill(f.codex, 'large');
  await fs.truncate(join(source, 'SKILL.md'), 2 * 1024 * 1024);
  await f.write(join(source, 'asset.bin'), '');
  await fs.truncate(join(source, 'asset.bin'), 51 * 1024 * 1024);
  const scan = await scanCodexSkills({ home: f.home });
  expect(scan.items[0]!.status).toBe('ready');
  const result = await importCodexSkills({ home: f.home, selection: selection(scan.items) });
  expect(result.items[0]!.status).toBe('imported');
  expect((await fs.stat(join(result.items[0]!.target, 'SKILL.md'))).size).toBe(2 * 1024 * 1024);
  expect(await streamImportFile(join(result.items[0]!.target, 'asset.bin')))
    .toBe(await streamImportFile(join(source, 'asset.bin')));
});

it('reports invalid YAML, dangling/cyclic roots, cyclic resources and credential links without leaking contents', async () => {
  const f = await fixture();
  await f.write(join(f.codex, 'invalid', 'SKILL.md'), '---\nname: [parser-secret\n---\n');
  await fs.symlink('missing', join(f.codex, 'dangling'), 'dir');
  await fs.symlink('cycle', join(f.codex, 'cycle'), 'dir');
  const cyclic = await f.skill(f.codex, 'nested-cycle');
  await fs.symlink('.', join(cyclic, 'loop'), 'dir');
  const sensitive = await f.skill(f.codex, 'sensitive');
  await f.write(join(f.home.osHomeDir, '.ssh', 'fixture'), 'never copy');
  await fs.symlink(join(f.home.osHomeDir, '.ssh'), join(sensitive, 'credentials'), 'dir');
  const scan = await scanCodexSkills({ home: f.home });
  expect(Object.fromEntries(scan.items.map(({ name, reason }) => [name, reason]))).toEqual({
    invalid: 'invalid-skill', dangling: 'unreadable', cycle: 'cyclic-link',
    'nested-cycle': 'cyclic-link', sensitive: 'sensitive-link',
  });
  expect(scan.counts.custom).toBe(0);
  expect(JSON.stringify(scan)).not.toContain('parser-secret');
});

it('does not peel a plugin-cache skill out through a user skill alias', async () => {
  const f = await fixture();
  const plugin = await f.skill(join(f.home.userConfigRoot, 'plugins', 'cache', 'one'), 'plugin');
  await fs.symlink(plugin, join(f.agents, 'plugin'), 'dir');
  expect((await scanCodexSkills({ home: f.home })).items[0]).toMatchObject({ status: 'skipped', reason: 'excluded' });
});

it('matches native metadata limits while allowing spaced names and long or block descriptions', async () => {
  const f = await fixture();
  await f.write(join(f.codex, 'block', 'SKILL.md'), '---\nname: block\ndescription: >-\n  First line\n  second line\n---\nBody stays private.\n');
  await f.write(join(f.codex, 'spaced', 'SKILL.md'), '---\nname: Friendly Skill\ndescription: Description\n---\n');
  await f.write(join(f.codex, 'long-description', 'SKILL.md'), '---\nname: long-description\ndescription: ' + 'x'.repeat(1025) + '\n---\n');
  await f.write(join(f.codex, 'long-name', 'SKILL.md'), '---\nname: ' + 'n'.repeat(65) + '\ndescription: Description\n---\n');
  const scan = await scanCodexSkills({ home: f.home });
  expect(scan.count).toBe(3);
  expect(scan.items.find(({ name }) => name === 'block')).toMatchObject({ status: 'ready', description: 'First line second line' });
  expect(scan.items.find(({ name }) => name === 'Friendly Skill')).toMatchObject({ status: 'ready' });
  expect(scan.items.filter(({ reason }) => reason === 'invalid-skill')).toHaveLength(1);
});

it('keeps distinct same-name sources as conflicts and protects a differently named existing target folder', async () => {
  const f = await fixture();
  await f.skill(f.codex, 'first', 'same-name');
  await f.skill(f.agents, 'second', 'same-name');
  const scan = await scanCodexSkills({ home: f.home });
  expect(scan.items).toHaveLength(2);
  expect(new Set(scan.items.map(({ localSourceId }) => localSourceId)).size).toBe(2);
  expect(scan.items.every(({ status, reason }) => status === 'conflict' && reason === 'same-name')).toBe(true);
  await fs.rm(join(f.agents, 'second'), { recursive: true });
  await f.skill(join(f.home.configRoot, 'skills'), 'user-folder', 'same-name');
  expect((await scanCodexSkills({ home: f.home })).items[0]).toMatchObject({ status: 'conflict', reason: 'same-name' });
});

it('rejects changed source fingerprints and leaves edited targets alone', async () => {
  const f = await fixture();
  const source = await f.skill(f.agents, 'edit');
  const scan = await scanCodexSkills({ home: f.home });
  await f.write(join(source, 'resource.txt'), 'added after preview');
  expect((await importCodexSkills({ home: f.home, selection: selection(scan.items) })).items[0])
    .toMatchObject({ status: 'conflict', reason: 'source-changed' });
  const fresh = await scanCodexSkills({ home: f.home });
  await importCodexSkills({ home: f.home, selection: selection(fresh.items) });
  await f.write(join(fresh.items[0]!.target, 'resource.txt'), 'user edited target');
  expect((await importCodexSkills({ home: f.home, selection: selection(fresh.items) })).items[0])
    .toMatchObject({ status: 'conflict', reason: 'target-differs' });
  expect(await fs.readFile(join(fresh.items[0]!.target, 'resource.txt'), 'utf8')).toBe('user edited target');
});

it('rejects cancellation with the original reason and removes every unpublished staging directory', async () => {
  const f = await fixture();
  await f.skill(f.codex, 'cancel');
  const scan = await scanCodexSkills({ home: f.home });
  const controller = new AbortController();
  const aborted = new Error('fixture cancellation');
  const original = fs.mkdtemp.bind(fs);
  vi.spyOn(fs, 'mkdtemp').mockImplementation((async (...args: Parameters<typeof fs.mkdtemp>) => {
    const created = await original(...args);
    controller.abort(aborted);
    return created;
  }) as typeof fs.mkdtemp);
  await expect(importCodexSkills({ home: f.home, signal: controller.signal, selection: selection(scan.items) })).rejects.toBe(aborted);
  expect(await fs.readdir(join(f.home.configRoot, 'skills'))).toEqual([]);
  await expect(scanCodexSkills({ home: f.home, signal: controller.signal })).rejects.toBe(aborted);
});

it('checks the whole selected batch and existing staging budget before writing on low disk space', async () => {
  const f = await fixture();
  await f.skill(f.codex, 'one');
  await f.skill(f.agents, 'two');
  const scan = await scanCodexSkills({ home: f.home });
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0, bsize: 4096 } as never);
  await expect(importCodexSkills({ home: f.home, selection: selection(scan.items) }))
    .rejects.toMatchObject({ code: 'AGENT_HOME_INSUFFICIENT_SPACE', space: { availableBytes: 0 } });
  await expect(fs.lstat(join(f.home.configRoot, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
});
