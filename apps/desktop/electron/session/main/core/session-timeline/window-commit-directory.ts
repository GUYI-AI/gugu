import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';

const openings = new Map<string, Promise<void>>();
/** Bounded host-generated namespace components, never a path from a renderer. */
export async function prepareWindowCommitDirectory(directory: string, parts: readonly string[]) {
  if (!parts.length || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
    throw new Error('Invalid commit directory');
  const target = join(directory, ...parts), marker = join(target, '.ready');
  const previous = openings.get(target); if (previous) return previous;
  const run = (async () => {
    try { if (!(await stat(marker)).isFile()) throw new Error('Invalid commit namespace marker'); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(target, { recursive: true });
    for (let depth = parts.length; depth >= 0; depth--) await syncWindowDirectory(join(directory, ...parts.slice(0, depth)));
    // This marker is created only after all parents were synced. The next frame
    // sync persists its entry. A missing marker repeats initialization after a
    // crash; there is no history-sized set of initialized directories in memory.
    const file = await open(marker, 'a', 0o600); await file.close();
  })();
  openings.set(target, run);
  try { await run; } finally { if (openings.get(target) === run) openings.delete(target); }
}
