import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as disk } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { appendAgentHomeHistory, resolveAgentHome, planAgentHomeHistory, importAgentHome, readAgentHomeMarker, readAgentHomePending, AGENT_HISTORY_LIMIT } from '@gugu/session-core/agents/plugins/helpers';
import { codexSessionBundleDescriptor } from './codex/session-bundle';
import { claudeSessionBundleDescriptor } from './claude/session-bundle';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const newest = '00000000-0000-4000-8000-000000000001';
const older = '00000000-0000-4000-8000-000000000002';
const oldest = '00000000-0000-4000-8000-000000000003';
async function fixture(kind: 'codex' | 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'harness-history-budget-')); roots.push(root);
  const bundle = kind === 'codex' ? codexSessionBundleDescriptor : claudeSessionBundleDescriptor;
  const home = resolveAgentHome({ providerId: kind, injectionMode: bundle.injectionMode, configRoot: bundle.configRoot,
    guguHome: join(root, 'gugu'), osHomeDir: join(root, 'user'), sourceEnv: {} })!;
  await mkdir(home.userConfigRoot, { recursive: true });
  const add = async (path: string, bytes: number, at: number) => {
    const file = join(home.userConfigRoot, path); await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'x'.repeat(bytes)); await utimes(file, at, at);
  };
  return { home, add };
}

it('selects whole Codex raw/archive bundles as a recent prefix, not smaller older files that happen to fit', async () => {
  const { home, add } = await fixture('codex');
  await add(`sessions/2026/rollout-${newest}.jsonl`, 400, 300);
  await add(`archived_sessions/rollout-${newest}.jsonl.zst`, 200, 250);
  await add(`sessions/rollout-${older}.jsonl`, 500, 200);
  await add(`sessions/rollout-${oldest}.jsonl`, 10, 100);
  await add('state_5.sqlite', 2000, 400);
  const plan = await planAgentHomeHistory(home, 1000);
  expect(plan).toMatchObject({ sessions: 1, bytes: 600, issues: [] });
  expect(plan.skipped.map(item => item.id)).toEqual([older, oldest]);
  expect(plan.paths).toHaveLength(2);
  expect(plan.paths.every(path => path.includes(newest))).toBe(true);
  expect((await stat(join(home.userConfigRoot, `sessions/rollout-${older}.jsonl`))).size).toBe(500);
});

it('keeps the newest oversized session whole and gives each harness its own budget', async () => {
  for (const kind of ['codex', 'claude'] as const) {
    const { home, add } = await fixture(kind);
    const prefix = kind === 'codex' ? 'sessions/' : 'projects/project/';
    await add(`${prefix}${newest}.jsonl`, 1200, 300);
    await add(`${prefix}${older}.jsonl`, 100, 200);
    const plan = await planAgentHomeHistory(home, 1000);
    expect(plan).toMatchObject({ sessions: 1, bytes: 1200, skipped: [{ id: older }] });
    expect(plan.paths).toEqual([`${prefix}${newest}.jsonl`]);
  }
});

it('budgets Claude subagents, file history and todos with their session while keeping project memory in full', async () => {
  const { home, add } = await fixture('claude');
  await add(`projects/project/${newest}.jsonl`, 300, 100);
  await add(`projects/project/${newest}/subagents/agent-x.jsonl`, 100, 400);
  await add(`file-history/${newest}/file@v1`, 200, 200);
  await add(`todos/${newest}-agent-x.json`, 50, 200);
  await add(`projects/project/${older}.jsonl`, 500, 300);
  await add('projects/project/memory/MEMORY.md', 2000, 500);
  const plan = await planAgentHomeHistory(home, 1000);
  expect(plan).toMatchObject({ sessions: 1, bytes: 2650, skipped: [{ id: older }] });
  expect(plan.paths).toHaveLength(5);
  expect(plan.paths).toContain('projects/project/memory/MEMORY.md');
});

it('imports Codex prompts and memories in full outside the history budget', async () => {
  const { home, add } = await fixture('codex');
  await add('prompts/continue.md', 1400, 300);
  await add('memories/memory_summary.md', 2200, 300);
  await add(`sessions/${newest}.jsonl`, 400, 300);
  await add(`sessions/${older}.jsonl`, 800, 200);
  const plan = await planAgentHomeHistory(home, 1000);
  await importAgentHome(home, { groups: new Set(['rules']), historyPaths: plan.paths, migratedFrom: 'shared' });
  expect((await readFile(join(home.configRoot, 'prompts/continue.md'))).length).toBe(1400);
  expect((await readFile(join(home.configRoot, 'memories/memory_summary.md'))).length).toBe(2200);
  expect((await readFile(join(home.configRoot, `sessions/${newest}.jsonl`))).length).toBe(400);
  await expect(stat(join(home.configRoot, `sessions/${older}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('publishes at the final home, records an interrupted preparation, and resumes without recopying source history', async () => {
  const { home, add } = await fixture('codex');
  await add(`sessions/${newest}.jsonl`, 400, 300);
  const options = { groups: new Set<'rules'>(['rules']), migratedFrom: 'shared' as const, historyPaths: [`sessions/${newest}.jsonl`] };
  await expect(importAgentHome(home, { ...options, prepareAfterPublish: async () => {
    expect(await readAgentHomeMarker(home)).toBeNull();
    expect(await readAgentHomePending(home)).not.toBeNull();
    expect((await readFile(join(home.configRoot, `sessions/${newest}.jsonl`))).length).toBe(400);
    await writeFile(join(home.configRoot, 'native-watermark'), 'batch-1');
    throw new Error('interrupted');
  } })).rejects.toMatchObject({ stage: 'history', cause: { message: 'interrupted' } });
  expect(await readAgentHomeMarker(home)).toBeNull();
  await rm(home.userConfigRoot, { recursive: true });
  await importAgentHome(home, { ...options, prepareAfterPublish: async () => {
    expect(await readFile(join(home.configRoot, 'native-watermark'), 'utf8')).toBe('batch-1');
    expect(await readAgentHomeMarker(home)).toBeNull();
  } });
  expect(await readAgentHomePending(home)).toBeNull();
  expect(await readAgentHomeMarker(home)).toMatchObject({ migratedFrom: 'shared' });
});


it('uses exactly four GiB and makes the oversize exception only for the newest session', async () => {
  const { home, add } = await fixture('codex');
  await add(`sessions/${newest}.jsonl`, 1, 300);
  await add(`sessions/${older}.jsonl`, 1, 200);
  await truncate(join(home.userConfigRoot, `sessions/${newest}.jsonl`), AGENT_HISTORY_LIMIT - 1);
  await truncate(join(home.userConfigRoot, `sessions/${older}.jsonl`), 2);
  await utimes(join(home.userConfigRoot, `sessions/${newest}.jsonl`), 300, 300);
  await utimes(join(home.userConfigRoot, `sessions/${older}.jsonl`), 200, 200);
  expect(await planAgentHomeHistory(home)).toMatchObject({ sessions: 1, bytes: 4_294_967_295, skipped: [{ id: older }] });
  await truncate(join(home.userConfigRoot, `sessions/${newest}.jsonl`), AGENT_HISTORY_LIMIT + 1);
  await utimes(join(home.userConfigRoot, `sessions/${newest}.jsonl`), 300, 300);
  expect(await planAgentHomeHistory(home)).toMatchObject({ sessions: 1, bytes: 4_294_967_297, skipped: [{ id: older }] });
})

it('leaves an already migrated managed history untouched', async () => {
  const { home, add } = await fixture('codex');
  await add(`sessions/${newest}.jsonl`, 400, 300);
  await add(`sessions/${older}.jsonl`, 600, 200);
  await importAgentHome(home, { groups: new Set(['rules']), migratedFrom: 'shared', historyPaths: ['sessions'] });
  let prepared = false;
  await importAgentHome(home, { groups: new Set(['rules']), migratedFrom: 'shared', historyPaths: [`sessions/${newest}.jsonl`], prepareAfterPublish: async () => { prepared = true } });
  expect(prepared).toBe(false);
  expect((await readFile(join(home.configRoot, `sessions/${older}.jsonl`))).length).toBe(600);
})


it('plans an explicit native-session selection without importing archived, unselected or non-session history', async () => {
  const { home, add } = await fixture('codex');
  const userHome = { ...home, upgradeHistory: ['sessions'] };
  const selected = `sessions/rollout-${older}.jsonl`;
  await add(`sessions/rollout-${newest}.jsonl`, 500, 300);
  await add(selected, 600, 200);
  await add(`archived_sessions/rollout-${oldest}.jsonl`, 100, 100);
  await add('sessions/not-a-native-session.txt', 10, 400);
  const plan = await planAgentHomeHistory(userHome, 1000, { sessionIds: new Set([older]), includeShared: false });
  expect(plan).toMatchObject({ sessions: 1, bytes: 600, sessionBytes: 600, skipped: [], issues: [] });
  expect(plan.paths).toEqual([selected]);
  expect((await stat(join(home.userConfigRoot, selected))).size).toBe(600);
});

it('does not copy an orphaned session auxiliary file in an explicit manual task import', async () => {
  const { home, add } = await fixture('claude');
  await add(`todos/${older}-agent-x.json`, 30, 200);
  await add('projects/project/memory/MEMORY.md', 40, 100);
  const plan = await planAgentHomeHistory(home, 1000, { sessionIds: new Set([older]), includeShared: false });
  expect(plan).toMatchObject({ sessions: 0, bytes: 0, paths: [], skipped: [], issues: [] });
});

it('appends a manual selection after an automatic marker while preserving a newer managed continuation', async () => {
  const { home, add } = await fixture('codex');
  const first = `sessions/${newest}.jsonl`, second = `sessions/${older}.jsonl`;
  await add(first, 10, 100);
  await importAgentHome(home, { groups: new Set(), historyPaths: [first] });
  const marker = await readAgentHomeMarker(home);
  await writeFile(join(home.configRoot, first), 'managed continuation');
  await add(second, 20, 200);
  const result = await appendAgentHomeHistory(home, [first, second], {
    signal: new AbortController().signal,
    validate: async root => {
      expect(await readFile(join(root, first), 'utf8')).toBe('x'.repeat(10));
      await expect(stat(join(home.configRoot, second))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  });
  expect(result).toEqual({ added: [second], preserved: [first] });
  expect(await readFile(join(home.configRoot, first), 'utf8')).toBe('managed continuation');
  expect(await readFile(join(home.configRoot, second), 'utf8')).toBe('x'.repeat(20));
  expect(await readAgentHomeMarker(home)).toEqual(marker);
});

it('publishes nothing when staged validation fails or a selected original disappears', async () => {
  const { home, add } = await fixture('codex');
  const path = `sessions/${newest}.jsonl`;
  await add(path, 20, 100);
  await expect(appendAgentHomeHistory(home, [path], { signal: new AbortController().signal,
    validate: async () => { throw new Error('wrong native ID'); } })).rejects.toThrow('wrong native ID');
  await expect(stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
  await rm(join(home.userConfigRoot, path));
  await expect(appendAgentHomeHistory(home, [path], { signal: new AbortController().signal, validate: async () => {} })).rejects.toThrow();
  await expect(stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels before publication without modifying the source', async () => {
  const { home, add } = await fixture('codex');
  const path = `sessions/${newest}.jsonl`;
  await add(path, 20, 100);
  const controller = new AbortController();
  await expect(appendAgentHomeHistory(home, [path], { signal: controller.signal,
    validate: async () => { controller.abort(new Error('cancelled')); } })).rejects.toThrow('cancelled');
  expect(await readFile(join(home.userConfigRoot, path), 'utf8')).toBe('x'.repeat(20));
  await expect(stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes the entire staged batch if the disk fills during its second file', async () => {
  const { home, add } = await fixture('codex');
  const first = `sessions/${newest}.jsonl`, second = `sessions/${older}.jsonl`;
  await add(first, 20, 100); await add(second, 30, 200);
  const realOpen = disk.open.bind(disk);
  const spy = vi.spyOn(disk, 'open').mockImplementation(async (path, flags, mode) => {
    if (String(path).includes('.gugu-history-') && String(path).endsWith(second) && flags === 'wx') {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return realOpen(path, flags, mode);
  });
  try {
    await expect(appendAgentHomeHistory(home, [first, second], { signal: new AbortController().signal,
      validate: async () => {} })).rejects.toMatchObject({ code: 'ENOSPC' });
    for (const path of [first, second]) await expect(stat(join(home.configRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(home.userConfigRoot, first), 'utf8')).toBe('x'.repeat(20));
  } finally { spy.mockRestore(); }
});
