import {
  windowLiveAckRequestSchema, windowLiveAckResultSchema, windowLivePositionRequestSchema,
  windowLivePositionResponseSchema, windowLiveReadRequestSchema, windowLiveReadResultSchema,
  type WindowCommitPage, type WindowLiveApi, type WindowLiveCursor, type WindowLivePositionResult,
  type WindowLiveResult,
} from '@gugu/session-wire/session-window-live';

const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
const invalid = () => fault('invalid_live_response', 'The committed history response does not match this request');
const sameEpoch = (a: WindowLiveCursor, b: WindowLiveCursor) => a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch;
function decode<T>(schema: { safeParse(value: unknown): { success: false } | { success: true; data: WindowLiveResult<T> } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  if (!parsed.data.ok) throw fault(parsed.data.error.code, parsed.data.error.message);
  return parsed.data.value;
}
const freezeCursor = (cursor: WindowLiveCursor) => Object.freeze({ ...cursor });
function freezePage(page: WindowCommitPage): WindowCommitPage {
  return Object.freeze({ ...page, next: freezeCursor(page.next), entries: Object.freeze(page.entries.map(entry => entry.kind === 'insert'
    ? Object.freeze({ ...entry, firstCommitCursor: freezeCursor(entry.firstCommitCursor), latestRevisionCursor: freezeCursor(entry.latestRevisionCursor) })
    : Object.freeze({ ...entry, firstCommitCursor: entry.firstCommitCursor && freezeCursor(entry.firstCommitCursor), latestRevisionCursor: freezeCursor(entry.latestRevisionCursor) }))) });
}

/** Uses only the public wire. The IPC binding supplies the real generated API;
 * the history owner invalidates isCurrent before releasing its subscription. */
export function createAcpWindowLiveClient(
  input: { conversationId: string; subscriptionId: string }, api: WindowLiveApi, isCurrent: () => boolean,
) {
  const owner = Object.freeze({ ...input });
  const current = () => { if (!isCurrent()) throw fault('unsubscribed', 'The history view was released'); };
  return {
    async read(after: WindowLiveCursor): Promise<WindowCommitPage> {
      current();
      const request = windowLiveReadRequestSchema.parse({ ...owner, after });
      Object.freeze(request.after); Object.freeze(request);
      const response = await api.read(request); current();
      const page = decode(windowLiveReadResultSchema, response);
      if (!sameEpoch(page.next, request.after) || page.entries[0].latestRevisionCursor.sequence <= request.after.sequence) throw invalid();
      return freezePage(page);
    },
    async ack(through: WindowLiveCursor): Promise<void> {
      current();
      const request = windowLiveAckRequestSchema.parse({ ...owner, through });
      Object.freeze(request.through); Object.freeze(request);
      const response = await api.ack(request); current();
      decode(windowLiveAckResultSchema, response);
    },
    async position(referenceId: string, appliedCursor: WindowLiveCursor): Promise<WindowLivePositionResult> {
      current();
      const request = windowLivePositionRequestSchema.parse({ ...owner, referenceId, appliedCursor });
      Object.freeze(request.appliedCursor); Object.freeze(request);
      const response = await api.position(request); current();
      const result = decode(windowLivePositionResponseSchema, response);
      if (result.kind === 'not_committed') {
        if (!sameEpoch(result.sampledCursor, request.appliedCursor) || result.sampledCursor.sequence < request.appliedCursor.sequence) throw invalid();
        return Object.freeze({ ...result, sampledCursor: freezeCursor(result.sampledCursor) });
      }
      if (result.position.referenceId !== request.referenceId || !sameEpoch(result.latestRevisionCursor, request.appliedCursor)) throw invalid();
      return Object.freeze({ ...result, position: Object.freeze({ ...result.position }),
        firstCommitCursor: result.firstCommitCursor && freezeCursor(result.firstCommitCursor), latestRevisionCursor: freezeCursor(result.latestRevisionCursor) });
    },
  };
}
