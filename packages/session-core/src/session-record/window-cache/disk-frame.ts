import { randomUUID } from 'node:crypto';
import { link, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWindowFrame, encodeWindowFrame, MAX_WINDOW_FILE_BYTES, windowFrameName, type WindowFrameKey, type WindowFrameRead } from './frame.ts';
import { WindowBudgetExceeded } from './read-budget.ts';
import type { WindowBudget } from './types';
export type FrameWriteFs = Pick<typeof import('node:fs/promises'), 'open' | 'link' | 'rename' | 'rm'>;
const nativeWriteFs: FrameWriteFs = { open, link, rename, rm };

/** Errors from durability calls are observable; rename alone is never called durable. */
export async function syncWindowDirectory(directory: string, fs: FrameWriteFs = nativeWriteFs): Promise<void> {
  const file = await fs.open(directory, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

export async function readWindowFrame(directory: string, key: WindowFrameKey, budget: WindowBudget): Promise<WindowFrameRead> {
  const path = join(directory, windowFrameName(key));
  try {
    const file = await open(path, 'r');
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size < 48n || before.size > BigInt(key.kind === 'head' ? 4096 : MAX_WINDOW_FILE_BYTES)) return { kind: 'miss', reason: 'format' };
      let packet: Uint8Array = new Uint8Array(0), used = 0, failed = false, failure: unknown;
      await budget.read('indexBytes', Number(before.size), async () => {
        packet = new Uint8Array(Number(before.size));
        try {
          while (used < packet.length) {
            const { bytesRead } = await file.read(packet, used, packet.length - used, used);
            if (!bytesRead) break;
            used += bytesRead;
          }
        } catch (error) { failed = true; failure = error; }
        return used;
      });
      if (failed) throw failure;
      const after = await file.stat({ bigint: true });
      if (used !== packet.length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
        return { kind: 'miss', reason: 'format' };
      return decodeWindowFrame(key, packet);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof WindowBudgetExceeded) throw error;
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'miss', reason: 'not_found' } : { kind: 'miss', reason: 'io', error };
  }
}

/** Host supplies an existing durable namespace. Content is immutable; only a head permits replacement. */
export async function writeWindowFrame(directory: string, key: WindowFrameKey, bytes: Uint8Array, fs: FrameWriteFs = nativeWriteFs): Promise<void> {
  const packet = encodeWindowFrame(key, bytes);
  const path = join(directory, windowFrameName(key));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(packet); await file.sync(); } finally { await file.close(); }
    if (key.kind === 'head') await fs.rename(temporary, path);
    else await fs.link(temporary, path);
    await syncWindowDirectory(directory, fs);
  } finally { await fs.rm(temporary, { force: true }); }
}
