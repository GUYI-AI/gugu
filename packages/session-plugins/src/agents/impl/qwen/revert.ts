import type { AcpRevertHook } from '@gugu/session-core/agents/plugins';

/**
 * Rewind on Qwen Code's own ACP server (#2970), measured on 0.27.4 (`chunks/acpAgent-*.js`):
 * · `qwen/status/session/rewind_snapshots {sessionId}` lists one rewind point per prompt still in the model history,
 *   `{ promptId, turnIndex, … }`; `promptId` is `<sessionId>########<n>` and is not sent anywhere else to a client.
 * · `qwen/control/session/rewind {sessionId, promptId, rewindFiles}` drops that prompt and everything after it, in place,
 *   and appends a `system/rewind` branch to the chat record (read root→leaf by `qwen-jsonl.ts`).
 *   Files are restored unless `rewindFiles` is `false`, so `keep` must say so. The answer is `{success, filesChanged, filesFailed}`.
 *   Measured on 0.27.4 over raw ACP: keep leaves a file the rewound turn wrote, restore removes it, and a restart +
 *   `session/load` stays rewound.
 */
const SNAPSHOTS = 'qwen/status/session/rewind_snapshots';
const REWIND = 'qwen/control/session/rewind';

type Snapshot = { promptId?: unknown; turnIndex?: unknown };

/** The newest point per session already handed out: a turn that made no snapshot of its own gets none. */
const lastPoint = new Map<string, string>();

export const qwenRevert: AcpRevertHook = {
  async anchorAfterTurn(agent, sessionId) {
    const result = await agent.extMethod!(SNAPSHOTS, { sessionId }) as { snapshots?: Snapshot[] };
    if (!Array.isArray(result?.snapshots)) throw new Error(`${SNAPSHOTS} answered without snapshots`);
    let newest: { promptId: string; turnIndex: number } | null = null;
    for (const snapshot of result.snapshots) {
      if (typeof snapshot.promptId !== 'string' || typeof snapshot.turnIndex !== 'number') continue;
      if (!newest || snapshot.turnIndex > newest.turnIndex) newest = { promptId: snapshot.promptId, turnIndex: snapshot.turnIndex };
    }
    if (!newest || lastPoint.get(sessionId) === newest.promptId) return null;
    lastPoint.set(sessionId, newest.promptId);
    return { before: newest.promptId, files: true };
  },
  async revert(agent, { sessionId, before, files }) {
    const result = await agent.extMethod!(REWIND, { sessionId, promptId: before, rewindFiles: files === 'restore' }) as
      { success?: unknown; filesFailed?: unknown };
    lastPoint.delete(sessionId);
    if (result?.success !== true) throw new Error('Qwen Code did not rewind the conversation');
    const failed = Array.isArray(result.filesFailed) ? result.filesFailed : [];
    if (failed.length) throw new Error(`Qwen Code rewound the conversation but could not restore ${failed.join(', ')}`);
  },
};
