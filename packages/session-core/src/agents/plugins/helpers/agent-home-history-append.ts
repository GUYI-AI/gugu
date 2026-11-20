import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ResolvedAgentHome } from '../capabilities/config-root';
import { checkAgentHomeImportSpace, copyAgentHomeHistory, streamImportFile } from './agent-home-import';

const disk: typeof fs = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : fs;

async function directory(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('History path escapes its home');
  let current = root;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try { await disk.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await disk.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid managed history directory');
  }
}

/**
 * Manual selection adds history to an already live home. Stage first, then publish complete files
 * without replacing any existing continuation or swapping the home under a running Codex.
 */
export async function appendAgentHomeHistory(
  home: ResolvedAgentHome,
  paths: readonly string[],
  options: { signal: AbortSignal; validate: (root: string) => Promise<void> },
): Promise<{ added: string[]; preserved: string[] }> {
  options.signal.throwIfAborted();
  const selected = [...new Set(paths)];
  for (const path of selected) {
    if (isAbsolute(path) || path.split(/[/\\]/).includes('..') || !home.historySession?.(path)) throw new Error('Invalid selected history');
  }
  await checkAgentHomeImportSpace([{ home, groups: new Set(), historyPaths: selected }]);
  await disk.mkdir(dirname(home.shadowHome), { recursive: true, mode: 0o700 });
  await directory(home.shadowHome, home.configRoot);
  const stage = await disk.mkdtemp(join(dirname(home.shadowHome), '.gugu-history-'));
  const stagingHome = { ...home, shadowHome: stage, configRoot: join(stage, 'history') };
  const added: { path: string; ino: number; dev: number }[] = [];
  const preserved: string[] = [];
  try {
    const issues = await copyAgentHomeHistory(stagingHome, selected, undefined, options.signal);
    if (issues.length) throw new Error('会话原文在复制时发生变化，请重新扫描后导入');
    for (const path of selected) {
      const source = join(home.userConfigRoot, path), target = join(stagingHome.configRoot, path);
      // Also catches files disappearing between planning and copying.
      const [before, after] = await Promise.all([streamImportFile(source), streamImportFile(target)]);
      if (before !== after) throw new Error('会话原文在复制时发生变化，请重新扫描后导入');
    }
    await options.validate(stagingHome.configRoot);
    for (const path of selected) {
      options.signal.throwIfAborted();
      const source = join(stagingHome.configRoot, path), target = join(home.configRoot, path);
      if (!(await disk.lstat(source)).isFile()) throw new Error('Selected history is not a regular file');
      await directory(home.shadowHome, dirname(target));
      try {
        // link is an atomic no-replace publication on the same filesystem.
        await disk.link(source, target);
        const stat = await disk.lstat(target);
        added.push({ path, ino: stat.ino, dev: stat.dev });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await disk.lstat(target)).isFile()) throw new Error('Invalid managed history file');
        preserved.push(path);
      }
    }
    return { added: added.map(item => item.path), preserved };
  } catch (error) {
    // Only remove files this publication created. Never remove another writer's replacement.
    for (const item of added.reverse()) {
      const target = join(home.configRoot, item.path);
      const stat = await disk.lstat(target).catch(() => null);
      if (stat?.ino === item.ino && stat.dev === item.dev) await disk.unlink(target);
    }
    throw error;
  } finally { await disk.rm(stage, { recursive: true, force: true }); }
}
