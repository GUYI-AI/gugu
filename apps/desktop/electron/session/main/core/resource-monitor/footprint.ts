import { readFile } from 'node:fs/promises';

/**
 * Memory a process alone accounts for, so per-process numbers add up: macOS phys_footprint (through the bundled native
 * helper, `process.footprint`), Linux anonymous resident + swap from /proc. Summing RSS instead counts every shared page
 * once per process — on macOS (11-07) 1542 MB of RSS for 665 MB of footprint. Windows and a Mac without the helper
 * (an uncompiled dev checkout) have no reader and keep RSS, labelled as such.
 */
export type FootprintReader = (pids: number[]) => Promise<Map<number, number>>;

/** Set at startup on macOS: the native helper's reader, or null while the helper is missing. */
let macReader: () => FootprintReader | null = () => null;
export function setMacFootprintReader(reader: () => FootprintReader | null): void { macReader = reader; }

export function footprintReader(platform: NodeJS.Platform = process.platform): FootprintReader | null {
  if (platform === 'linux') return readLinuxFootprints;
  if (platform === 'darwin') return macReader();
  return null;
}

const kib = (status: string, field: string) => Number(status.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0) * 1024;

export async function readLinuxFootprints(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(pids.map(async (pid) => {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      if (/^RssAnon:/m.test(status)) out.set(pid, kib(status, 'RssAnon') + kib(status, 'VmSwap'));
    } catch { /* exited between listing and reading: falls back to its RSS */ }
  }));
  return out;
}
