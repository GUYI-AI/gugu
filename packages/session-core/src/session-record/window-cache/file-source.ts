import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import type { WindowByteSource } from './types';

/** Pin the descriptor and validate the pathname; fstat alone misses atomic replacement. */
export async function openWindowByteSource(path: string, pathStat = (target: string) => stat(target, { bigint: true })): Promise<WindowByteSource & { close(): Promise<void> }> {
  const canonical = await realpath(path);
  const file = await open(canonical, 'r');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const sourceId = digest(canonical);
  return {
    async snapshot() {
      const descriptor = await file.stat({ bigint: true });
      const named = await pathStat(path);
      const instance = (info: typeof descriptor) => `${info.dev}:${info.ino}:${info.birthtimeNs}`;
      const fingerprint = (info: typeof descriptor) => `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      // A normal append between fstat and stat changes size/times, never physical ownership.
      if (!descriptor.isFile() || !named.isFile() || instance(descriptor) !== instance(named)) throw new Error('Native record source was replaced');
      if (descriptor.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Native record offset is not representable');
      return { sourceId, sourceInstance: digest(`${sourceId}:${descriptor.dev}:${descriptor.ino}:${descriptor.birthtimeNs}`),
        snapshotRevision: digest(fingerprint(descriptor)), size: Number(descriptor.size) };
    },
    async read(target, offset, length, position) {
      return (await file.read(target, offset, length, position)).bytesRead;
    },
    close: () => file.close(),
  };
}
