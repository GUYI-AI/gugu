import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from '../../lib/proper-lockfile';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import type { ManagedAgentVersions, ManagedAgentVersionCleanup } from '@shared/core/agents/managed-versions';
import { managedAgentPrefix, managedMiseBinDir } from './managed-agent-home';
import { bundledMisePath, miseEnvironment, miseToolName } from './mise-installer';
import { runMiseProcess } from './mise-process';
import type { MiseTarget } from './mise-distribution';
import { withManagedLauncherPublication } from './managed-launcher-publication';

type Entry = { version: string; install_path: string; installed: boolean };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Recognize the exact launcher format we publish, with a directory boundary, never a version guess. */
export function currentManagedEntry(entries: Entry[], script: string, launcherDirectory: string, platform = process.platform): Entry {
  const paths = platform === 'win32' ? path.win32 : path;
  const lines = script.split(/\r?\n/);
  const matches = entries.filter(entry => {
    if (!entry.installed) return false;
    const directory = paths.resolve(entry.install_path) + paths.sep;
    const prefix = platform === 'win32'
      ? '"%~dp0' + paths.relative(launcherDirectory, directory) + paths.sep
      : 'exec ' + quote(directory).slice(0, -1);
    return lines.some(line => platform === 'win32' ? line.toLowerCase().startsWith(prefix.toLowerCase()) : line.startsWith(prefix));
  });
  if (matches.length !== 1) throw new Error('The current managed installation could not be identified');
  return matches[0]!;
}

async function context(target: MiseTarget) {
  const root = path.join(managedAgentPrefix(), 'mise');
  const work = path.join(root, 'operations', target.binary);
  await access(work);
  const mise = bundledMisePath();
  await access(mise);
  const env = miseEnvironment(root, path.join(work, 'global.toml'), buildAgentEnv());
  const tool = miseToolName(target);
  const run = (args: string[], timeout = 15_000) => runMiseProcess(mise, args, { cwd: work, env, signal: AbortSignal.timeout(timeout) });
  const inventory = async (): Promise<Entry[]> => {
    const value: unknown = JSON.parse(await run(['ls', '--json', tool]));
    if (!Array.isArray(value) || value.some(entry => !entry || typeof entry.version !== 'string'
      || !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(entry.version) || typeof entry.install_path !== 'string' || typeof entry.installed !== 'boolean')) {
      throw new Error('Invalid managed installation inventory');
    }
    return value;
  };
  const snapshot = async (): Promise<ManagedAgentVersions> => {
    const entries = await inventory();
    const launcher = path.join(managedMiseBinDir(), target.binary + (process.platform === 'win32' ? '.cmd' : ''));
    const current = currentManagedEntry(entries, await readFile(launcher, 'utf8'), managedMiseBinDir());
    return { currentVersion: current.version, versions: [...new Set(entries.filter(entry => entry.installed).map(entry => entry.version))] };
  };
  return { work, tool, run, snapshot };
}

export async function readManagedAgentVersions(target: MiseTarget): Promise<ManagedAgentVersions> {
  return (await context(target)).snapshot();
}

/** The same per-tool and publication locks used by installation; explicit selected versions only. */
export async function cleanupManagedAgentVersions(target: MiseTarget, requested: string[]): Promise<ManagedAgentVersionCleanup> {
  if (!Array.isArray(requested) || requested.length === 0 || requested.some(version => typeof version !== 'string')) throw new Error('Select at least one installed old version');
  const selected = [...new Set(requested)];
  const ctx = await context(target);
  let compromised: Error | undefined;
  const release = await lockfile.lock(ctx.work, { realpath: false, stale: 30_000, update: 10_000, retries: 0, onCompromised: error => { compromised = error; } });
  try {
    return await withManagedLauncherPublication(async assertOwned => {
      const before = await ctx.snapshot();
      // Validate the whole selection before the first destructive command. A stale UI cannot delete the new current.
      if (selected.some(version => version === before.currentVersion || !before.versions.includes(version))) throw new Error('The version list changed. Read it again before cleaning up');
      const failed: ManagedAgentVersionCleanup['failed'] = [];
      for (const version of selected) {
        if (compromised) throw compromised;
        assertOwned();
        try { await ctx.run(['uninstall', ctx.tool + '@' + version], 60_000); }
        catch (error) { failed.push({ version, error: error instanceof Error ? error.message : String(error) }); }
      }
      if (compromised) throw compromised;
      assertOwned();
      const snapshot = await ctx.snapshot();
      if (compromised) throw compromised;
      assertOwned();
      for (const version of selected) if (snapshot.versions.includes(version) && !failed.some(item => item.version === version)) {
        failed.push({ version, error: 'The version is still installed after cleanup' });
      }
      return { snapshot, removed: selected.filter(version => !snapshot.versions.includes(version)), failed };
    });
  } finally { await release(); }
}
