import path from 'node:path';
import type { NormalizedEvent } from '@gugu/session-core/acp';
import { canonicalPath } from '@gugu/session-core/files';

/**
 * @@@canonical-path at the door every harness's events come in by (`buildAgentClient`): the files a tool call names —
 * its locations and the files its patches change — are put in their one spelling before anything records or compares
 * them. An agent that still names a folder by an old spelling (a session begun before a server's account folder moved)
 * then edits and opens the same file, and its Edited card and the file it opened are one card, one tab.
 * A relative path is the harness's own business (it has no folder here): left as said.
 */
const canonical = (value: unknown): unknown => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  try { return canonicalPath(value); } catch { return value; }
};

function canonicalBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const record = block as Record<string, unknown>;
  if (record.type === 'diff' && Array.isArray(record.changes)) {
    return { ...record, changes: record.changes.map((change: Record<string, unknown>) => ({
      ...change,
      ...('path' in change ? { path: canonical(change.path) } : {}),
      ...('oldPath' in change ? { oldPath: canonical(change.oldPath) } : {}),
    })) };
  }
  return record.content !== undefined ? { ...record, content: Array.isArray(record.content) ? record.content.map(canonicalBlock) : canonicalBlock(record.content) } : record;
}

export function canonicalToolPaths(event: NormalizedEvent): NormalizedEvent {
  if (event.kind === 'subagent_stream') return { ...event, event: canonicalToolPaths(event.event) };
  if (event.kind !== 'tool_call' && event.kind !== 'tool_update') return event;
  const locations = event.locations?.map((location) => ({ ...location, path: canonical(location.path) as string }));
  const contentBlocks = event.contentBlocks?.map(canonicalBlock) as typeof event.contentBlocks;
  return {
    ...event,
    ...(event.locations ? { locations } : {}),
    ...(event.contentBlocks ? { contentBlocks } : {}),
  } as NormalizedEvent;
}
