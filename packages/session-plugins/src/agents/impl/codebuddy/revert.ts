import type { AcpRevert } from '@gugu/session-core/agents/plugins';

/**
 * Revert on CodeBuddy Code's own ACP server, read in 2.184.0 (`dist/codebuddy.js`):
 * · `session/prompt` answers with a top-level `userMessageId`: the record id of the user item this turn added.
 * · `_codebuddy.ai/session/rollback {sessionId, targetMessageId, reason}` moves the conversation back to that item's
 *   parent, in place, and appends a `resend-fork-notice` to the record (`codebuddy-jsonl.ts`).
 *   An unknown id or a `reason` other than `resend_edit` / `checkpoint_revert` is not an RPC error: the answer says
 *   `applied: false`, or nothing happens at all ⇒ always send `reason`, always check `applied`.
 * Measured on 2.184.0 over raw ACP: after a rollback to before turn 2 the next request carries only turn 1, and a
 * restart + `session/load` stays rolled back. Its file rollback (`files: true`) answered
 * `FILE_ROLLBACK_METADATA_UNAVAILABLE` there, so this hook rewinds the conversation only and never offers files.
 */
const ROLLBACK = '_codebuddy.ai/session/rollback';

export const codebuddyRevert: AcpRevert = {
  point(_agent, _sessionId, response) {
    const id = response.userMessageId;
    return typeof id === 'string' && id ? { before: id } : null;
  },
  async revert(agent, sessionId, before, restoreFiles) {
    if (restoreFiles) throw new Error('CodeBuddy rewinds the conversation only; its points never offer files');
    const result = await agent.extMethod!(ROLLBACK, { sessionId, targetMessageId: before, reason: 'resend_edit' }) as { applied?: unknown; error?: unknown };
    if (result?.applied !== true) throw new Error(`CodeBuddy did not roll back: ${String(result?.error ?? 'no reason given')}`);
  },
};
