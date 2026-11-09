import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowBudget } from './read-budget';
import { readSourceLocator } from './source-locator';
import { createSourceReopenResolver } from './reopen-source';

const metering = vi.hoisted(() => ({ entries: 0, readBytes: 0, buffers: [] as number[], afterRead: null as (() => void) | null,
  beforeRead: null as (() => Promise<void>) | null, openDirectories: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original,
    readdir: vi.fn(() => { throw new Error('Whole directory listing is forbidden'); }),
    readFile: vi.fn(() => { throw new Error('Whole file reading is forbidden'); }),
    open: async (...args: Parameters<typeof original.open>) => {
      const file = await original.open(...args), read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation((async (...values: unknown[]) => {
        const result = await Reflect.apply(read, file, values); metering.readBytes += result.bytesRead; return result;
      }) as typeof file.read);
      return file;
    },
    opendir: async (path: string, options: { bufferSize: number }) => {
      metering.buffers.push(options.bufferSize);
      const directory = await original.opendir(path, options), read = directory.read.bind(directory);
      metering.openDirectories += 1;
      const close = directory.close.bind(directory);
      vi.spyOn(directory, 'close').mockImplementation((async () => { await close(); metering.openDirectories -= 1; }) as typeof directory.close);
      vi.spyOn(directory, 'read').mockImplementation((async () => {
        await metering.beforeRead?.();
        const result = await read(); metering.entries += 1; metering.afterRead?.(); return result;
      }) as typeof directory.read);
      return directory;
    },
  };
});
const fixtures: string[] = [], resolvers: ReturnType<typeof createSourceReopenResolver>[] = [];
beforeEach(() => { metering.entries = 0; metering.readBytes = 0; metering.buffers = []; metering.afterRead = null; metering.beforeRead = null; });
afterEach(async () => {
  await Promise.all(resolvers.splice(0).map(resolver => resolver.dispose()));
  expect(metering.openDirectories).toBe(0);
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup(harness: 'claude' | 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gugu-reopen-'))); fixtures.push(root);
  const native = join(root, 'native'); await mkdir(native);
  const resolver = createSourceReopenResolver(); resolvers.push(resolver);
  return { resolver, native, root, request: { cacheDirectory: join(root, 'cache'), locator: { harness, providerSessionId: 'session', roots: [native] } } };
}

describe('bounded native source discovery for desktop reopen', () => {
  it.each(['claude', 'codex'] as const)('restarts discovery after a terminal %s miss when the native file later appears', async harness => {
    const input = await setup(harness), request = { ...input.request, cwd: '/project' };
    expect(await input.resolver.resolveSourceForReopen(request, createWindowBudget())).toEqual({ kind: 'cache_miss', reason: 'not_found' });
    const directory = harness === 'claude' ? join(input.native, '-project') : input.native;
    await mkdir(directory, { recursive: true });
    const path = join(directory, harness === 'claude' ? 'session.jsonl' : 'rollout-native-session.jsonl'); await writeFile(path, '{}\n');
    expect(await input.resolver.resolveSourceForReopen(request, createWindowBudget())).toMatchObject({ kind: 'located', path });
  });

  it('locates Claude directly from cwd and publishes a durable source binding without reading its body', async () => {
    const input = await setup('claude'), cwd = '/project/my repo';
    const directory = join(input.native, '-project-my-repo'); await mkdir(directory);
    const path = join(directory, 'session.jsonl'); await writeFile(path, '{"text":"hello"}\n');
    const budget = createWindowBudget();
    expect(await input.resolver.resolveSourceForReopen({ ...input.request, cwd }, budget)).toMatchObject({ kind: 'located', path });
    expect(metering.readBytes).toBe(0); expect(metering.entries).toBe(0); expect(budget.counters.sourceBytes).toBe(0);
    expect(await readSourceLocator(input.request.cacheDirectory, 'claude', 'session', budget)).toMatchObject({ kind: 'hit', locator: { path } });
  });

  it('keeps an explicit missing address a miss instead of switching to directory discovery', async () => {
    const input = await setup('codex'); await writeFile(join(input.native, 'rollout-real-session.jsonl'), '{}\n');
    expect(await input.resolver.resolveSourceForReopen({ ...input.request, nativeSourcePath: join(input.native, 'missing') }, createWindowBudget()))
      .toEqual({ kind: 'cache_miss', reason: 'not_found' });
    expect(metering.entries).toBe(0);
  });

  it('resumes bounded metadata discovery across requests without collecting or rereading directory entries', async () => {
    const input = await setup('codex');
    await Promise.all(Array.from({ length: 130 }, (_, index) => writeFile(join(input.native, `irrelevant-${index}`), '')));
    const second = join(input.root, 'second'), leaf = join(second, '2026', '11', '07'); await mkdir(leaf, { recursive: true });
    const path = join(leaf, 'rollout-native-session.jsonl'); await writeFile(path, '{}\n');
    const request = { ...input.request, locator: { ...input.request.locator, roots: [input.native, second] } };
    let cursor = '', total = 0, located = false;
    for (let batch = 0; batch < 150; batch += 1) {
      const before = metering.entries, result = await input.resolver.resolveSourceForReopen(request, createWindowBudget());
      expect(metering.entries - before).toBeLessThanOrEqual(64); total += metering.entries - before;
      if (result.kind === 'located') { expect(result.path).toBe(path); located = true; break; }
      if (result.kind !== 'unlocated') throw new Error('Discovery incorrectly reported absence');
      expect(result.examinedEntries).toBeGreaterThan(0); if (cursor) expect(result.cursor).toBe(cursor); cursor = result.cursor;
    }
    expect(located).toBe(true); expect(total).toBe(135); expect(metering.readBytes).toBe(0);
    expect(metering.buffers.every(size => size === 1)).toBe(true);
  });

  it('retains an already consumed entry when cancellation arrives during directory IO', async () => {
    const input = await setup('codex'), path = join(input.native, 'rollout-native-session.jsonl'); await writeFile(path, '{}\n');
    const controller = new AbortController(); metering.afterRead = () => controller.abort();
    await expect(input.resolver.resolveSourceForReopen(input.request, createWindowBudget(), controller.signal)).rejects.toThrow();
    const before = metering.entries; metering.afterRead = null;
    expect(await input.resolver.resolveSourceForReopen(input.request, createWindowBudget())).toMatchObject({ kind: 'located', path });
    expect(metering.entries).toBe(before);
  });

  it('rejects a symlink outside declared roots and never publishes its source-current', async () => {
    const input = await setup('claude'), outside = join(input.root, 'session.jsonl'); await writeFile(outside, '{}\n');
    const path = join(input.native, 'session.jsonl'); await symlink(outside, path);
    await expect(input.resolver.resolveSourceForReopen({ ...input.request, nativeSourcePath: path }, createWindowBudget())).rejects.toThrow('outside');
    expect(await readSourceLocator(input.request.cacheDirectory, 'claude', 'session', createWindowBudget())).toMatchObject({ kind: 'miss' });
    await input.resolver.dispose();
    await expect(input.resolver.resolveSourceForReopen(input.request, createWindowBudget())).rejects.toThrow('disposed');
  });

  it('resets the single directory continuation when switching A to B and back to A', async () => {
    const input = await setup('codex');
    await Promise.all(Array.from({ length: 130 }, (_, index) => writeFile(join(input.native, `entry-${index}`), '')));
    const first = await input.resolver.resolveSourceForReopen(input.request, createWindowBudget());
    expect(first.kind).toBe('unlocated'); expect(metering.openDirectories).toBe(1);
    const path = join(input.native, 'B.jsonl'); await writeFile(path, '{}\n');
    const other = { ...input.request, locator: { ...input.request.locator, harness: 'claude' as const, providerSessionId: 'B' }, nativeSourcePath: path };
    expect(await input.resolver.resolveSourceForReopen(other, createWindowBudget())).toMatchObject({ kind: 'located', path });
    expect(metering.openDirectories).toBe(0);
    const again = await input.resolver.resolveSourceForReopen(input.request, createWindowBudget());
    expect(again.kind).toBe('unlocated');
    if (first.kind === 'unlocated' && again.kind === 'unlocated') expect(again.cursor).not.toBe(first.cursor);
  });

  it('serializes concurrent calls rather than sharing an active directory read', async () => {
    const input = await setup('codex'), path = join(input.native, 'rollout-native-session.jsonl'); await writeFile(path, '{}\n');
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    metering.beforeRead = async () => { metering.beforeRead = null; entered(); await gate; };
    const first = input.resolver.resolveSourceForReopen(input.request, createWindowBudget()); await reading;
    const second = input.resolver.resolveSourceForReopen(input.request, createWindowBudget());
    expect(metering.openDirectories).toBe(1); resume();
    expect(await first).toMatchObject({ kind: 'located', path });
    expect(await second).toMatchObject({ kind: 'located', path });
  });
});
