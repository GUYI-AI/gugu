import { join } from 'node:path';

import type { TranscriptTurn } from '../../acp/models/turns/turn';
import type { SessionRecordLocator, SessionRecordSource } from '../contract';
import { isFile } from './find-file';
import { createJsonlTailSource } from './jsonl-tail-source';
import { SessionRecordNotFoundError, type SessionRecordSourceOptions } from './shared';

/**
 * Gugu's own journal of a session: what no agent record holds. A harness gugu has no reader for, and the turns gugu
 * itself adds to a session (an agent's notification to its owner), are written here, one whole turn per line, only
 * appended: `{ id, at, turn }`. `<root>/<session id>.jsonl`, `providerSessionId` being gugu's session id.
 *
 * It is read like any record (the same tail reader); its turns come already folded (`RecordEntry.committed`), and the
 * timeline places them among the record's turns by when they started.
 */
export type JournalLine = { id: string; at: number; turn: TranscriptTurn };

export function createGuguJournalSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return createJsonlTailSource<null>(locator, options, {
    name: 'gugu',
    resumeVersion: 1,
    resolve: () => resolveJournal(locator),
    initial: () => null,
    decode: (line) => {
      if (typeof line.id !== 'string' || typeof line.at !== 'number' || !line.turn || typeof line.turn !== 'object') return null;
      return [{ key: `gugu:${line.id}`, at: line.at, committed: { ...(line.turn as TranscriptTurn), id: line.id } }];
    },
  });
}

async function resolveJournal(locator: SessionRecordLocator): Promise<string> {
  const paths = locator.roots.map((root) => join(root, `${locator.providerSessionId}.jsonl`));
  for (const path of paths) {
    if (await isFile(path)) return path;
  }
  throw new SessionRecordNotFoundError(`no gugu journal: sessionId=${locator.providerSessionId}`, paths);
}
