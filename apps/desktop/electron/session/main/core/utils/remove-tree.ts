import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * @@@sync-rm-follows-junctions - Electron 44's Node (24.18) on Windows: fs.rmSync / rmdirSync with recursive go
 * through a junction and empty what it points at, even when the junction itself is the path given, and rmSync refuses
 * a read-only file. fs.promises.rm does neither, so async callers use that; this is for callers that must stay sync.
 * A link is unlinked, never entered. A missing path is fine.
 */
export function removeTreeSync(target: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) return fs.unlinkSync(target);
  for (const name of fs.readdirSync(target)) removeTreeSync(path.join(target, name));
  fs.rmdirSync(target);
}
