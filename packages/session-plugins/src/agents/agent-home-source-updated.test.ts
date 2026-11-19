import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { importAgentHome, scanAgentHome, resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { claudeSessionBundleDescriptor } from './impl/claude/session-bundle';
import { codexSessionBundleDescriptor } from './impl/codex/session-bundle';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const cases = [
  { provider: 'claude', descriptor: claudeSessionBundleDescriptor, config: 'settings.json', initial: '{"theme":"dark"}', changed: '{"theme":"light"}' },
  { provider: 'codex', descriptor: codexSessionBundleDescriptor, config: 'config.toml', initial: 'model = "before"', changed: 'model = "after"' },
] as const;
async function fixture(value: typeof cases[number]) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-source-update-'));
  roots.push(root);
  const home = resolveAgentHome({ providerId: value.provider, injectionMode: value.descriptor.injectionMode,
    configRoot: value.descriptor.configRoot, guguHome: join(root, 'managed'), osHomeDir: join(root, 'user'), sourceEnv: {} })!;
  async function source(path: string, content: string) {
    const full = join(home.userConfigRoot, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    await utimes(full, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
  }
  await source(value.config, value.initial);
  if (value.provider === 'claude') await source('../.claude.json', '{"mcpServers":{},"numStartups":1}');
  await importAgentHome(home, { groups: new Set(home.importGroups.filter(group => group.id !== 'hooks').map(group => group.id)), now: new Date('2026-11-19T00:00:00Z') });
  expect((await scanAgentHome(home)).sourceUpdated).toBe(false);
  return { home, source };
}

it.each(cases)('$provider runtime writes do not mark imported configuration as updated', async value => {
  const { home, source } = await fixture(value);
  const generated = value.provider === 'codex' ? ['skills/.system/cache.json'] : ['plugins/cache/generated.json'];
  for (const path of ['logs/latest.log', 'state_5.sqlite', 'state_5.sqlite-wal', 'models_cache.json', 'sessions/session.jsonl', ...generated]) {
    await source(path, 'runtime output');
  }
  if (value.provider === 'claude') await source('../.claude.json', '{"mcpServers":{},"numStartups":2,"oauthAccount":{"accountUuid":"runtime"}}');
  await source(value.config, value.initial); // Touching unchanged imported content also must not trigger it.
  expect((await scanAgentHome(home)).sourceUpdated).toBe(false);
});

it.each(cases)('$provider marks changed imported configuration as updated', async value => {
  const { home, source } = await fixture(value);
  await source(value.config, value.changed);
  expect((await scanAgentHome(home)).sourceUpdated).toBe(true);
});

it('detects added and deleted files within imported groups', async () => {
  const value = cases[1];
  const { home, source } = await fixture(value);
  await source('AGENTS.md', 'new imported rules');
  expect((await scanAgentHome(home)).sourceUpdated).toBe(true);
  await rm(join(home.userConfigRoot, 'AGENTS.md'));
  await rm(join(home.userConfigRoot, value.config));
  expect((await scanAgentHome(home)).sourceUpdated).toBe(true);
});
