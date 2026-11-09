import { join } from 'node:path';
import { readWindowFrame as readFrame, writeWindowFrame as writeFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowFrameKey } from '@gugu/session-core/session-record/window-cache/frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { prepareWindowCommitDirectory } from './window-commit-directory';

type Binding = Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'>;
const parts = (b: Binding) => ['projection-versions', b.scope, `${b.sourceLineage}-${b.decoderVersion}`];
export function windowCommitProjectionDirectory(directory: string, binding: Binding) {
  if (!/^[a-f0-9]{64}$/.test(binding.scope) || !/^[a-f0-9]{64}$/.test(binding.sourceLineage)
    || !Number.isSafeInteger(binding.decoderVersion) || binding.decoderVersion < 1) throw new Error('Invalid projection namespace');
  return join(directory, ...parts(binding));
}

/** Projection-only namespace. The 0048 receipt's raw source stays at its original
 * immutable path. A legacy flat projection is an explicit bounded cache miss,
 * rebuilt through its receipt; never moved or silently treated as an empty page. */
export function readWindowFrame(directory: string, key: WindowFrameKey, budget: WindowBudget) {
  return readFrame(windowCommitProjectionDirectory(directory, key), key, budget);
}
export async function writeWindowFrame(directory: string, key: WindowFrameKey, bytes: Uint8Array) {
  windowCommitProjectionDirectory(directory, key);
  await prepareWindowCommitDirectory(directory, parts(key));
  await writeFrame(windowCommitProjectionDirectory(directory, key), key, bytes);
}
