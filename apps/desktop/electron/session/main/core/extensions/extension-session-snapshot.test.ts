import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  bundleContentDigest,
  ensureSessionSnapshot,
  pruneSessionSnapshots,
  removeUninstalledLeftovers,
  sessionSnapshotDir,
} from './extension-session-snapshot';
import * as snapshots from './extension-session-snapshot';
import { ExtensionsService } from './extensions-service';

/**
 * #6387 owner「时机和状态，你有理清吗」: an extension upgraded or uninstalled while a session
 * runs must not pull files from under that session's program or skills.
 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-6387-snap-'));
}

function bundle(root: string, version: string): string {
  const dir = path.join(root, 'installed', 'agent-notes');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp', 'server.mjs'), `// ${version}`);
  return dir;
}

describe('session snapshots of an extension (#6387)', () => {
  it('a running session keeps the version it started with through an upgrade and an uninstall', () => {
    const userData = tmp();
    const v1 = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    // 升级:装着的那份换成 v2,新会话拿到 v2 的副本,老会话那份原样还在。
    const v2 = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    expect(fs.readFileSync(path.join(v1, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1');
    expect(fs.readFileSync(path.join(v2, 'mcp', 'server.mjs'), 'utf8')).toBe('// v2');
    // 卸载:装着的那份没了,正在跑的会话读的副本还在。
    fs.rmSync(path.join(userData, 'installed'), { recursive: true });
    expect(fs.existsSync(path.join(v2, 'mcp', 'server.mjs'))).toBe(true);
  });

  it('a reinstall of the same version with changed code is another copy; the same bytes are the same digest (10-06)', () => {
    const userData = tmp();
    const installed = bundle(userData, 'v1');
    const first = bundleContentDigest(installed);
    ensureSessionSnapshot(installed, sessionSnapshotDir(userData, 'agent-notes', first));
    // Installed again at the same place (an install lands as a new folder: its times are new).
    bundle(userData, 'v1, changed');
    fs.utimesSync(installed, new Date(1_000_000), new Date(1_000_000));
    const second = bundleContentDigest(installed);
    expect(second).not.toBe(first);
    const copy = ensureSessionSnapshot(installed, sessionSnapshotDir(userData, 'agent-notes', second));
    expect(fs.readFileSync(path.join(copy, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1, changed');
    bundle(userData, 'v1');
    fs.utimesSync(installed, new Date(2_000_000), new Date(2_000_000));
    expect(bundleContentDigest(installed)).toBe(first);
  });

  it('the same version is copied once', () => {
    const userData = tmp();
    const target = sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64));
    ensureSessionSnapshot(bundle(userData, 'v1'), target);
    bundle(userData, 'changed-in-place');
    ensureSessionSnapshot(path.join(userData, 'installed', 'agent-notes'), target);
    expect(fs.readFileSync(path.join(target, 'mcp', 'server.mjs'), 'utf8')).toBe('// v1');
  });

  it('at the next start only the current version of installed extensions is kept', () => {
    const userData = tmp();
    const old = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    const current = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    const gone = ensureSessionSnapshot(bundle(userData, 'x'), sessionSnapshotDir(userData, 'uninstalled', 'c'.repeat(64)));
    pruneSessionSnapshots(userData, new Map([['agent-notes', 'b'.repeat(64)]]));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
  });
});

describe('an uninstalled App’s files: gone once its programs have exited (10-06)', () => {
  function dataRoot(userData: string): string {
    const root = path.join(userData, 'extension-data');
    for (const id of ['agent-notes', 'other']) {
      fs.mkdirSync(path.join(root, id), { recursive: true });
      fs.writeFileSync(path.join(root, id, 'notes.json'), '[1]');
    }
    return root;
  }

  it('takes its data folder and every frozen copy of it, and nothing of another App', async () => {
    const userData = tmp();
    const root = dataRoot(userData);
    const v1 = ensureSessionSnapshot(bundle(userData, 'v1'), sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
    const v2 = ensureSessionSnapshot(bundle(userData, 'v2'), sessionSnapshotDir(userData, 'agent-notes', 'b'.repeat(64)));
    const other = ensureSessionSnapshot(bundle(userData, 'o'), sessionSnapshotDir(userData, 'other', 'c'.repeat(64)));
    await removeUninstalledLeftovers(userData, path.join(root, 'agent-notes'), 'agent-notes');
    expect([v1, v2, path.join(root, 'agent-notes')].filter((dir) => fs.existsSync(dir))).toEqual([]);
    expect([other, path.join(root, 'other', 'notes.json')].every((dir) => fs.existsSync(dir))).toBe(true);
  });

  it('startup keeps App data when its installation directory is missing, while pruning obsolete bundle copies', () => {
    const userData = tmp();
    try {
      const root = dataRoot(userData);
      const installed = bundle(userData, 'v1');
      const frozen = ensureSessionSnapshot(installed, sessionSnapshotDir(userData, 'agent-notes', 'a'.repeat(64)));
      fs.rmSync(path.join(userData, 'installed'), { recursive: true });
      const service = new ExtensionsService(path.join(userData, 'installed'));
      const entry = path.resolve(__dirname, '../../embedded-boot.ts');
      const compiled = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      });
      const inert: unknown = new Proxy(function () { return inert; }, {
        get: (_target, key) => key === 'then' ? undefined : key === Symbol.iterator ? function* () {} : inert,
      });
      const imports: Record<string, Record<string, unknown>> = {
        electron: { app: { getPath: () => userData } },
        './core/extensions/extensions-root': { extensionsService: () => service },
        './core/extensions/extension-data': { EXTENSION_DATA_DIR_NAME: 'extension-data' },
        './core/extensions/extension-session-snapshot': snapshots,
      };
      const requireBuiltin = createRequire(import.meta.url);
      const load = (id: string) => id.startsWith('node:') ? requireBuiltin(id)
        : new Proxy(imports[id] ?? {}, { get: (target, key) => key in target ? target[key as string] : inert });
      const module = { exports: {} as { sweep: () => void } };
      runInNewContext(compiled.outputText + '\nmodule.exports.sweep = sweepExtensionSessionLeftovers;', {
        require: load, module, exports: module.exports, process, console, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval, __dirname: path.dirname(entry),
      });
      module.exports.sweep();

      expect(service.list()).toEqual({ extensions: [], invalid: [] });
      expect(fs.readFileSync(path.join(root, 'agent-notes', 'notes.json'), 'utf8')).toBe('[1]');
      expect(fs.readFileSync(path.join(root, 'other', 'notes.json'), 'utf8')).toBe('[1]');
      expect(fs.existsSync(frozen)).toBe(false);
    } finally { fs.rmSync(userData, { recursive: true, force: true }); }
  });
});
