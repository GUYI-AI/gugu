import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { importAgentHome, readAgentHomeMarker, resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { reimportTerminalAgentHome } from './agent-home-cli-import';

const control = vi.hoisted(() => ({ beforeApply: null as null | (() => Promise<void>), revisions: null as null | ReadonlyMap<string, string> }));
vi.mock('@gugu/session-core/agents/plugins/helpers', async original => {
  const actual = await original<typeof import('@gugu/session-core/agents/plugins/helpers')>();
  return { ...actual, reimportAgentHome: async (...args: Parameters<typeof actual.reimportAgentHome>) => {
    control.revisions = args[2] ?? null;
    await control.beforeApply?.();
    return actual.reimportAgentHome(...args);
  } };
});
let root: string;
let home: NonNullable<ReturnType<typeof resolveAgentHome>>;
const content = (name: string, value: string) => name.endsWith('.toml') ? `value = ${JSON.stringify(value)}\n` : value;
const source = (name: string, value: string) => writeFile(join(home.userConfigRoot, name), content(name, value));
const writeManaged = (name: string, value: string) => writeFile(join(home.configRoot, name), content(name, value));
const managed = async (name: string) => {
  const value = await readFile(join(home.configRoot, name), 'utf8');
  return name.endsWith('.toml') ? JSON.parse(value.trim().replace(/^value\s*=\s*/, '')) as string : value;
};
beforeEach(async () => {
  control.beforeApply = null; control.revisions = null;
  root = await mkdtemp(join(tmpdir(), 'terminal-reimport-3515-'));
  home = resolveAgentHome({ providerId: 'fixture', injectionMode: 'managed-config-root',
    guguHome: join(root, 'gugu'), osHomeDir: join(root, 'user'), sourceEnv: {},
    configRoot: { envVar: 'FIXTURE_CONFIG_HOME', userPath: '.fixture', evidence: 'Test terminal configuration.', carryExclusions: [], credentialPaths: [], importGroups: [
      { id: 'settings', paths: ['config.toml', 'other.toml'], evidence: 'Test settings.' },
      { id: 'rules', paths: ['RULES.md'], evidence: 'Test rules.' },
      { id: 'hooks', paths: ['hooks.json'], evidence: 'Test hooks.' },
    ] },
  })!;
  await mkdir(home.userConfigRoot, { recursive: true });
  await source('config.toml', 'base'); await source('other.toml', 'base-other');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const firstImport = () => importAgentHome(home, { groups: new Set(['settings', 'rules']) });

it('leaves unmarked and explicitly skipped homes to the original first-import path', async () => {
  expect(await reimportTerminalAgentHome(home, ['settings'])).toBeNull();
  await expect(managed('config.toml')).rejects.toMatchObject({ code: 'ENOENT' });
  await importAgentHome(home, { groups: new Set(), skip: true });
  expect(await reimportTerminalAgentHome(home, ['settings'])).toBeNull();
  expect(control.revisions).toBeNull();
});

it('updates changed and newly added terminal files after first import and remains idempotent on repeat/restart', async () => {
  await firstImport();
  await source('config.toml', 'terminal-v2'); await source('RULES.md', 'new rule');
  await source('auth.json', 'credential never copied');
  const result = await reimportTerminalAgentHome(home, ['settings', 'rules']);
  expect(result).toMatchObject({ result: { providerId: 'fixture', hasMarker: true, imported: 2, issues: [] } });
  expect(await managed('config.toml')).toBe('terminal-v2'); expect(await managed('RULES.md')).toBe('new rule');
  await expect(managed('auth.json')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(control.revisions?.size).toBe(2);
  expect([...control.revisions!.values()].every(revision => /^[a-f0-9]{64}$/.test(revision))).toBe(true);
  const marker = await readAgentHomeMarker(home);
  expect(await reimportTerminalAgentHome(home, ['settings', 'rules'])).toMatchObject({ result: { imported: 0 } });
  vi.resetModules();
  const restarted = await import('./agent-home-cli-import');
  expect(await restarted.reimportTerminalAgentHome(home, ['settings', 'rules'])).toMatchObject({ result: { imported: 0 } });
  expect(await readAgentHomeMarker(home)).toEqual(marker);
});

it('stops the entire command before writes when any selected file changed on both sides', async () => {
  await firstImport();
  await source('config.toml', 'terminal-v2'); await source('other.toml', 'terminal-other');
  await writeManaged('other.toml', 'gugu-other');
  const marker = await readAgentHomeMarker(home);
  expect(await reimportTerminalAgentHome(home, ['settings'])).toMatchObject({ error: { code: 'agent_home_conflict' } });
  expect(await managed('config.toml')).toBe('base'); expect(await managed('other.toml')).toBe('gugu-other');
  expect(await readAgentHomeMarker(home)).toEqual(marker); expect(control.revisions).toBeNull();
});

it('preserves Gugu-only edits and honors the requested groups without enabling hooks', async () => {
  await source('RULES.md', 'base rule'); await firstImport();
  await source('config.toml', 'terminal-v2'); await source('RULES.md', 'terminal rule'); await source('hooks.json', '{"command":"fixture-hook"}');
  await writeManaged('RULES.md', 'gugu rule');
  await writeManaged('other.toml', 'gugu-only edit');
  expect(await reimportTerminalAgentHome(home, ['settings'])).toMatchObject({ result: { imported: 1 } });
  expect(await managed('config.toml')).toBe('terminal-v2'); expect(await managed('other.toml')).toBe('gugu-only edit');
  expect(await managed('RULES.md')).toBe('gugu rule'); await expect(managed('hooks.json')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['source', 'managed'] as const)('rejects a stale revision if the %s changes between diff and publication', async side => {
  await firstImport(); await source('config.toml', 'terminal-v2');
  const marker = await readAgentHomeMarker(home);
  control.beforeApply = () => side === 'source' ? source('config.toml', 'terminal-v3') : writeManaged('config.toml', 'concurrent Gugu edit');
  await expect(reimportTerminalAgentHome(home, ['settings'])).rejects.toThrow('review the differences again');
  expect(await managed('config.toml')).toBe(side === 'source' ? 'base' : 'concurrent Gugu edit');
  expect(await readAgentHomeMarker(home)).toEqual(marker);
});
