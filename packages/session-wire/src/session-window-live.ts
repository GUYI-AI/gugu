import { z } from 'zod';

const id = z.string().min(1).max(2048);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WINDOW_LIVE_PAGE_ENTRIES = 8;
export const WINDOW_LIVE_PAGE_BYTES = 48 * 1024;

export const windowLiveCursorSchema = z.strictObject({
  workerEpoch: id, storeEpoch: id, sequence,
});
export type WindowLiveCursor = z.infer<typeof windowLiveCursorSchema>;

const sameEpoch = (a: WindowLiveCursor, b: WindowLiveCursor) =>
  a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch;
const equalCursor = (a: WindowLiveCursor, b: WindowLiveCursor) =>
  sameEpoch(a, b) && a.sequence === b.sequence;
const revisionFields = {
  firstCommitCursor: windowLiveCursorSchema.nullable(),
  latestRevisionCursor: windowLiveCursorSchema,
};
function validRevision(value: z.infer<z.ZodObject<typeof revisionFields>>): boolean {
  const first = value.firstCommitCursor, latest = value.latestRevisionCursor;
  return first === null || (sameEpoch(first, latest) && first.sequence <= latest.sequence);
}
const referenceFields = {
  referenceId: id, projectionId: id, rowId: id, storedSeq: sequence,
  ...revisionFields,
};

/** Inserts prove a live first commit. A historical update can lack that proof;
 * it may replace an existing resident row, but must not insert a new row. */
export const windowCommitReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...referenceFields, kind: z.literal('insert'), firstCommitCursor: windowLiveCursorSchema }),
  z.strictObject({ ...referenceFields, kind: z.literal('update') }),
]).refine(value => validRevision(value) && (value.kind !== 'insert'
  || equalCursor(value.firstCommitCursor, value.latestRevisionCursor)), 'Invalid commit revision');
export type WindowCommitReference = z.infer<typeof windowCommitReferenceSchema>;

/** Scalar references only: no turn, body, projection payload or runtime state. */
const commitPageShape = z.strictObject({
  entries: z.array(windowCommitReferenceSchema).min(1).max(WINDOW_LIVE_PAGE_ENTRIES).readonly(),
  next: windowLiveCursorSchema,
  hasMore: z.boolean(),
});
export const windowCommitPageSchema = commitPageShape.pipe(z.custom<z.infer<typeof commitPageShape>>(input => {
  // The pipe only reaches this check after the bounded scalar shape succeeds.
  const page = input as z.infer<typeof commitPageShape>;
  let previous = -1, bytes = 0;
  for (const entry of page.entries) {
    const latest = entry.latestRevisionCursor;
    if (!sameEpoch(latest, page.next) || latest.sequence <= previous) return false;
    previous = latest.sequence;
    bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  }
  return equalCursor(page.entries[page.entries.length - 1].latestRevisionCursor, page.next)
    && bytes <= WINDOW_LIVE_PAGE_BYTES;
}, 'Invalid commit page boundary or byte budget'));
export type WindowCommitPage = z.infer<typeof windowCommitPageSchema>;

const ownerFields = { conversationId: id, subscriptionId: id };
/** First after is the original liveCursor from Prepare for this same UUID.
 * Subsequent after is the last ACKed page end; never synthesize or resample it. */
export const windowLiveReadRequestSchema = z.strictObject({
  ...ownerFields, after: windowLiveCursorSchema,
});
export const windowLiveAckRequestSchema = z.strictObject({
  ...ownerFields, through: windowLiveCursorSchema,
});
export const windowLivePositionRequestSchema = z.strictObject({
  ...ownerFields, referenceId: id, appliedCursor: windowLiveCursorSchema,
});
export type WindowLiveReadRequest = z.infer<typeof windowLiveReadRequestSchema>;
export type WindowLiveAckRequest = z.infer<typeof windowLiveAckRequestSchema>;
export type WindowLivePositionRequest = z.infer<typeof windowLivePositionRequestSchema>;

export const windowLivePositionSchema = z.strictObject({
  projectionId: id, rowId: id, storedSeq: sequence, referenceId: id,
});
export type WindowLivePosition = z.infer<typeof windowLivePositionSchema>;
export const windowLivePositionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('committed'), position: windowLivePositionSchema, ...revisionFields }),
  z.strictObject({ kind: z.literal('not_committed'), sampledCursor: windowLiveCursorSchema }),
]).refine(value => value.kind !== 'committed' || validRevision(value), 'Invalid position revision');
export type WindowLivePositionResult = z.infer<typeof windowLivePositionResultSchema>;

export const windowLiveErrorSchema = z.strictObject({
  code: z.string().min(1).max(128), message: z.string().max(2048),
});
export type WindowLiveError = z.infer<typeof windowLiveErrorSchema>;
/** Domain result, distinct from session-shared's success/data result. Missing
 * durable descriptors return an error such as needs_location, not not_committed. */
export type WindowLiveResult<T> = { ok: true; value: T } | { ok: false; error: WindowLiveError };
function resultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: windowLiveErrorSchema }),
  ]);
}
export const windowLiveReadResultSchema = resultSchema(windowCommitPageSchema);
export const windowLiveAckResultSchema = resultSchema(z.void());
export const windowLivePositionResponseSchema = resultSchema(windowLivePositionResultSchema);

/** Host binds all calls to the same sender and subscription UUID. Read is the
 * only long wait; its delivered page stays frozen until ACK. Commit the bounded
 * projection and initial body atomically to resident state before ACK, then
 * always issue the next Read, irrespective of hasMore. Cancellation settles the
 * wait; failures are terminal and never cause automatic rereads or route changes. */
export interface WindowLiveApi {
  read(input: WindowLiveReadRequest): Promise<WindowLiveResult<WindowCommitPage>>;
  ack(input: WindowLiveAckRequest): Promise<WindowLiveResult<void>>;
  position(input: WindowLivePositionRequest): Promise<WindowLiveResult<WindowLivePositionResult>>;
}
