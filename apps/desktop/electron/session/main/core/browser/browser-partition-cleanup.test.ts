import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listPersistedBrowserPartitions,
  migrateLegacyBrowserPartitionDirs,
} from './browser-partition-cleanup';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const created: string[] = [];

/** 一个 `userData/Partitions` 目录,每个分区里放一份 Cookies,用来确认数据跟着目录走。 */
function partitionsDir(partitions: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-partitions-'));
  created.push(dir);
  for (const [name, cookies] of Object.entries(partitions)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'Cookies'), cookies);
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrateLegacyBrowserPartitionDirs', () => {
  it('moves the signed-in profiles and per-task partitions to their new names with their data', () => {
    const dir = partitionsDir({
      'emdash-browser-profile': 'session=default',
      'emdash-browser-profile-work': 'session=work',
      'emdash-browser-isolated-Project-Task': 'session=task',
    });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readdirSync(dir).sort()).toEqual([
      'gugu-browser-isolated-Project-Task',
      'gugu-browser-profile',
      'gugu-browser-profile-work',
    ]);
    expect(readFileSync(join(dir, 'gugu-browser-profile', 'Cookies'), 'utf8')).toBe('session=default');
  });

  it('leaves both directories alone when the new name already exists', () => {
    const dir = partitionsDir({
      'emdash-browser-profile': 'session=old',
      'gugu-browser-profile': 'session=new',
    });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readFileSync(join(dir, 'emdash-browser-profile', 'Cookies'), 'utf8')).toBe('session=old');
    expect(readFileSync(join(dir, 'gugu-browser-profile', 'Cookies'), 'utf8')).toBe('session=new');
  });

  it('does not move per-tab partitions or anything that is not a browser partition', () => {
    const dir = partitionsDir({ 'emdash-browser-tab-1': 'x', 'gugu-extension-paper-desk': 'y' });

    migrateLegacyBrowserPartitionDirs(dir);

    expect(readdirSync(dir).sort()).toEqual(['emdash-browser-tab-1', 'gugu-extension-paper-desk']);
  });

  it('does nothing when there is no Partitions directory yet', () => {
    expect(() => migrateLegacyBrowserPartitionDirs(join(tmpdir(), 'gugu-no-partitions-here'))).not.toThrow();
  });
});

describe('explicit browsing-data cleanup', () => {
  it('retains every old partition and includes it only when the person clears browsing data', async () => {
    const dir = partitionsDir({
      'emdash-browser-tab-1': 'x',
      'gugu-browser-tab-2': 'x',
      'emdash-browser-profile': 'kept because its new twin already existed',
      'gugu-browser-profile': 'keep',
      'gugu-browser-isolated-Project-Task': 'keep',
      'gugu-extension-paper-desk': 'keep',
    });

    migrateLegacyBrowserPartitionDirs(dir);
    const persisted = await listPersistedBrowserPartitions(dir);

    expect(readdirSync(dir).sort()).toEqual([
      'emdash-browser-profile',
      'emdash-browser-tab-1',
      'gugu-browser-isolated-Project-Task',
      'gugu-browser-profile',
      'gugu-browser-tab-2',
      'gugu-extension-paper-desk',
    ]);
    expect(readFileSync(join(dir, 'emdash-browser-tab-1', 'Cookies'), 'utf8')).toBe('x');
    expect(readFileSync(join(dir, 'gugu-browser-tab-2', 'Cookies'), 'utf8')).toBe('x');
    expect(persisted.sort()).toEqual([
      'persist:emdash-browser-profile', 'persist:emdash-browser-tab-1',
      'persist:gugu-browser-isolated-Project-Task', 'persist:gugu-browser-profile', 'persist:gugu-browser-tab-2',
    ]);

    const clear = vi.fn(async (_kind: string, _partitions: readonly string[]) => true);
    const inert: unknown = new Proxy(function () { return inert; }, {
      get: (_target, key) => key === 'then' ? undefined : key === Symbol.iterator ? function* () {} : inert,
    });
    const imports: Record<string, Record<string, unknown>> = {
      '@shared/lib/ipc/rpc': { createRPCController: (controller: unknown) => controller },
      '@shared/browser': { DEFAULT_BROWSER_PROFILE_ID: 'default', browserProfilePartition: (id: string) => id === 'default' ? 'persist:gugu-browser-profile' : `persist:gugu-browser-profile-${id}`, isBrowsingDataKind: (kind: string) => kind === 'all' },
      '@main/core/settings/settings-service': { appSettingsService: { get: async () => ({ profiles: [{ id: 'work' }] }) } },
      '@main/core/browser/browser-webcontents-registry': { browserWebContentsRegistry: { registeredPartitions: ['persist:gugu-browser-isolated-live'], clearBrowsingData: clear } },
      './browser-partition-cleanup': { listPersistedBrowserPartitions: () => listPersistedBrowserPartitions(dir) },
    };
    const entry = join(__dirname, 'controller.ts');
    const compiled = ts.transpileModule(readFileSync(entry, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const requireBuiltin = createRequire(import.meta.url);
    const module = { exports: {} as { browserController: { clearBrowsingData: (kind: string) => Promise<{ success: boolean }> } } };
    runInNewContext(compiled.outputText, {
      require: (id: string) => id.startsWith('node:') ? requireBuiltin(id)
        : new Proxy(imports[id] ?? {}, { get: (target, key) => key in target ? target[key as string] : inert }),
      module, exports: module.exports,
    });
    expect(clear).not.toHaveBeenCalled();
    expect(await module.exports.browserController.clearBrowsingData('all')).toEqual({ success: true });
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith('all', expect.arrayContaining([
      ...persisted, 'persist:gugu-browser-profile-work', 'persist:gugu-browser-isolated-live',
    ]));
    const targets = clear.mock.calls[0] as unknown as [string, string[]];
    expect(new Set(targets[1]).size).toBe(targets[1].length);
    expect(targets[1]).not.toContain('persist:gugu-extension-paper-desk');
  });

  it('an absent partition directory is empty, but an inspection failure is not an empty successful cleanup', async () => {
    const dir = partitionsDir({});
    expect(await listPersistedBrowserPartitions(join(dir, 'missing'))).toEqual([]);
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'not a readable partition directory');
    await expect(listPersistedBrowserPartitions(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
