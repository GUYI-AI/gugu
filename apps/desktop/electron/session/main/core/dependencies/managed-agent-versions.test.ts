import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledMisePath, managedLauncher } from './mise-installer';
import { managedAgentPrefix, managedMiseBinDir } from './managed-agent-home';
import { cleanupManagedAgentVersions, currentManagedEntry, readManagedAgentVersions } from './managed-agent-versions';

const mocks = vi.hoisted(() => ({ appRoot: '', run: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => mocks.appRoot } }));
vi.mock('./mise-process', async original => ({ ...(await original<typeof import('./mise-process')>()), runMiseProcess: mocks.run }));
vi.mock('@main/core/pty/pty-env', () => ({ buildAgentEnv: () => ({ PATH: '/fixture' }) }));
const target = { kind: 'mise' as const, package: '@vendor/agent', binary: 'agent', backend: { kind: 'platform-archive' as const, executables: {} } };
let home: string;
let entries: Array<{ version: string; install_path: string; installed: boolean }>;
const current = '1.3.0-official-content';
const launcher = () => path.join(managedMiseBinDir(), process.platform === 'win32' ? 'agent.cmd' : 'agent');
const work = () => path.join(managedAgentPrefix(), 'mise', 'operations', 'agent');
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'managed-versions-'));
  vi.stubEnv('GUGU_HOME', home); mocks.appRoot = home;
  await mkdir(path.dirname(bundledMisePath()), { recursive: true });
  await writeFile(bundledMisePath(), 'fixture engine');
  await mkdir(work(), { recursive: true });
  await mkdir(managedMiseBinDir(), { recursive: true });
  entries = ['1.1.0', '1.2.0', current].map(version => ({ version, installed: true, install_path: path.join(managedAgentPrefix(), 'mise', 'data', 'installs', 'http-gugu-agent', version) }));
  for (const entry of entries) { await mkdir(path.join(entry.install_path, 'bin'), { recursive: true }); await writeFile(path.join(entry.install_path, 'bin/agent'), 'retained program'); }
  await writeFile(launcher(), managedLauncher(path.join(entries[2].install_path, 'bin/agent'), undefined, '1.3.0'));
  mocks.run.mockReset().mockImplementation(async (_command, args) => {
    if (args[0] === 'ls') return JSON.stringify(entries);
    if (args[0] === 'uninstall') {
      const version = args[1].slice('http:gugu-agent@'.length);
      const entry = entries.find(item => item.version === version);
      if (!entry) throw new Error('unexpected uninstall target');
      await rm(entry.install_path, { recursive: true }); entries = entries.filter(item => item !== entry); return '';
    }
    throw new Error('unexpected mise command');
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('explicit managed version cleanup', () => {
  it('reads exact installed versions without deleting, protecting the launcher target rather than its display marker', async () => {
    expect(await readManagedAgentVersions(target)).toEqual({ currentVersion: current, versions: ['1.1.0', '1.2.0', current] });
    expect(mocks.run.mock.calls.every(call => call[1][0] === 'ls')).toBe(true);
  });
  it('only uninstalls the selected old version and preserves the launcher and other programs', async () => {
    const before = await readFile(launcher(), 'utf8');
    expect(await cleanupManagedAgentVersions(target, ['1.1.0'])).toEqual({ removed: ['1.1.0'], failed: [], snapshot: { currentVersion: current, versions: ['1.2.0', current] } });
    expect(await readFile(launcher(), 'utf8')).toBe(before);
    expect(await readFile(path.join(entries[0].install_path, 'bin/agent'), 'utf8')).toBe('retained program');
    expect(mocks.run.mock.calls.filter(call => call[1][0] === 'uninstall').map(call => call[1])).toEqual([['uninstall', 'http:gugu-agent@1.1.0']]);
  });
  it.each([[], [current], ['1.1.0', current], ['1.1.0', 'unknown']].map(selection => ({ selection })))('rejects the entire invalid selection $selection before deleting any version', async ({ selection }) => {
    await expect(cleanupManagedAgentVersions(target, selection)).rejects.toThrow();
    expect(mocks.run.mock.calls.some(call => call[1][0] === 'uninstall')).toBe(false);
    expect(entries).toHaveLength(3);
  });
  it('a new current version selected after the UI read is rechecked before cleanup', async () => {
    await writeFile(launcher(), managedLauncher(path.join(entries[0].install_path, 'bin/agent')));
    await expect(cleanupManagedAgentVersions(target, ['1.1.0'])).rejects.toThrow('changed');
    expect(entries).toHaveLength(3);
  });
  it('inventory failure is an error and never deletion permission', async () => {
    mocks.run.mockRejectedValue(new Error('inventory unavailable'));
    await expect(cleanupManagedAgentVersions(target, ['1.1.0'])).rejects.toThrow('inventory unavailable');
    expect(entries).toHaveLength(3);
  });
  it('an unreadable or unrecognized launcher denies cleanup', async () => {
    await writeFile(launcher(), 'unknown launcher');
    await expect(cleanupManagedAgentVersions(target, ['1.1.0'])).rejects.toThrow('identified');
    expect(entries).toHaveLength(3);
  });
  it('partial command failure preserves the failed version and reports the actual remaining inventory', async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation(async (...args) => { if (args[1][1] === 'http:gugu-agent@1.2.0') throw new Error('permission denied'); return run(...args); });
    expect(await cleanupManagedAgentVersions(target, ['1.1.0', '1.2.0'])).toMatchObject({ removed: ['1.1.0'], failed: [{ version: '1.2.0', error: 'permission denied' }], snapshot: { versions: ['1.2.0', current] } });
  });
  it('uses the installation lock instead of racing an ongoing update', async () => {
    const release = await lockfile.lock(work(), { realpath: false });
    try { await expect(cleanupManagedAgentVersions(target, ['1.1.0'])).rejects.toMatchObject({ code: 'ELOCKED' }); }
    finally { await release(); }
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('does not confuse version prefixes or Windows launcher paths', () => {
    const rows = ['1.2', '1.20'].map(version => ({ version, installed: true, install_path: `C:\\Gugu\\mise\\${version}` }));
    expect(currentManagedEntry(rows, '@echo off\r\n"%~dp0..\\mise\\1.20\\bin\\agent.exe" %*\r\n', 'C:\\Gugu\\bin', 'win32').version).toBe('1.20');
  });
});
