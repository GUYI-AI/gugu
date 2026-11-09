import type { JsonBodyPosition } from '@gugu/session-core/session-record/window-cache/body-reader';
import type { WindowFrameKey } from '@gugu/session-core/session-record/window-cache/frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import type { WindowCommitSourceManifest } from './window-commit-source';
import { createWindowCommitReader } from './window-commit-reader';

/** Read a proven JSON string range, with positions in the immutable serialized
 * source. Receipt/slot authorization belongs to the caller, not this decoder.
 * At most two physical frames are read; all bytes remain indexBytes. */
export async function readWindowCommitStringPage(directory: string,
  binding: Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'>, source: WindowCommitSourceManifest, options: {
    range: { start: number; end: number }; position: JsonBodyPosition; maxBytes: number; budget: WindowBudget; signal?: AbortSignal;
  }) {
  const reader = createWindowCommitReader(directory, binding, source, options.budget, options.signal);
  try { return await reader.string(options.range, options.position, options.maxBytes); }
  finally { reader.close(); }
}
