import type { AcpRevert } from '@gugu/session-core/agents/plugins';

/**
 * Revert on Qwen Code's own ACP server, measured on 0.27.4 (`chunks/acpAgent-*.js`):
 * · `qwen/status/session/rewind_snapshots {sessionId}` lists one rewind point per prompt still in the model history,
 *   `{ promptId, turnIndex, … }`; `promptId` is `<sessionId>########<n>` and is not sent anywhere else to a client.
 *   The newest one is the point of the turn that just ended (a turn without a snapshot reports the previous turn's;
 *   the cell does not put that one on a message twice).
 * · `qwen/control/session/rewind {sessionId, promptId, rewindFiles}` drops that prompt and everything after it, in place,
 *   and appends a `system/rewind` branch to the chat record (read root→leaf by `qwen-jsonl.ts`).
 *   Files are restored unless `rewindFiles` is `false`, so it is always sent. The answer is `{success, filesChanged, filesFailed}`.
 *   Measured on 0.27.4 over raw ACP: keep leaves a file the rewound turn wrote, restore removes it, and a restart +
 *   `session/load` stays rewound.
 */
const SNAPSHOTS = 'qwen/status/session/rewind_snapshots';
const REWIND = 'qwen/control/session/rewind';

type Snapshot = { promptId?: unknown; turnIndex?: unknown };

export const qwenRevert: AcpRevert = {
  async point(agent, sessionId) {
    const result = await agent.extMethod!(SNAPSHOTS, { sessionId }) as { snapshots?: Snapshot[] };
    if (!Array.isArray(result?.snapshots)) throw new Error(`${SNAPSHOTS} answered without snapshots`);
    let newest: { promptId: string; turnIndex: number } | null = null;
    for (const snapshot of result.snapshots) {
      if (typeof snapshot.promptId !== 'string' || typeof snapshot.turnIndex !== 'number') continue;
      if (!newest || snapshot.turnIndex > newest.turnIndex) newest = { promptId: snapshot.promptId, turnIndex: snapshot.turnIndex };
    }
    return newest ? { before: newest.promptId, files: true } : null;
  },
  async revert(agent, sessionId, before, restoreFiles) {
    const result = await agent.extMethod!(REWIND, { sessionId, promptId: before, rewindFiles: restoreFiles }) as
      { success?: unknown; filesFailed?: unknown };
    if (result?.success !== true) throw new Error('Qwen Code did not rewind the conversation');
    const failed = Array.isArray(result.filesFailed) ? result.filesFailed : [];
    if (failed.length) throw new Error(`Qwen Code rewound the conversation but could not restore ${failed.join(', ')}`);
  },
};
