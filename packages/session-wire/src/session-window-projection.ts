import { z } from 'zod';
import { windowLiveErrorSchema, windowLivePositionSchema, type WindowLiveResult } from './session-window-live';

export const WINDOW_PROJECTION_BODY_BYTES = 16 * 1024;
export const WINDOW_PROJECTION_MEMBERS = 16;
export const WINDOW_PROJECTION_OUTPUT_BYTES = 128 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(2048);
const owner = { conversationId: id, subscriptionId: id };
const lease = z.uuid();
/** Authenticated host capability. Its contents, source ranges and decoder state
 * are never a renderer protocol, even when a continuation represents metadata. */
export const windowProjectionHandleSchema = z.string().min(40).max(2800).regex(/^[A-Za-z0-9_-]+$/);
const handle = windowProjectionHandleSchema;
const primitive = z.union([z.number().finite(), z.boolean(), z.null()]);
const scalar = z.union([primitive, z.string().max(512).refine(value => bytes(value) <= 512)]);
const fieldKind = z.enum(['string', 'array', 'object']);
const target = z.enum(['turn', 'item', 'terminal']);

const toolFields = 'id seq kind toolCallId title toolKind toolName status at completedAt inputSummary backgroundTaskId backgroundTaskDone parentToolCallId locations contentBlocks images imageRefs';
/** Public canonical header vocabulary for host producers; these scalar facts
 * are not a partial TranscriptItem or permission to manufacture missing fields. */
export const WINDOW_PROJECTION_ITEM_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  message: 'id seq kind role at attachments files ownerNotification revertAnchor content',
  thinking: 'id seq kind segmentId status startedAt durationMs content',
  compaction: 'id seq kind compactionId status startedAt trigger preTokens postTokens durationMs summary error',
  'context-reset': 'id seq kind reason at', 'session-notice': 'id seq kind code detail effectiveValue previousValue title at',
  'tool-group': 'id seq kind label groupKind status',
  ...Object.fromEntries(Object.entries({
    'execute-tool-call': 'command terminalId exitStatus', 'read-tool-call': 'path resource', 'patch-tool-call': '',
    'search-tool-call': 'query matchCount', 'mcp-tool-call': 'server tool', 'web-fetch-tool-call': 'url pageTitle',
    'spawn-subagent-tool-call': 'subagentSessionId agentStatus agentStartedAt canCancel reasoningText name background agentId model startedAt',
    'subagent-done-tool-call': 'name agentId launchToolCallId outcome summary outputFile',
    'background-command-done-tool-call': 'name launchToolCallId outcome summary',
    'create-plan-tool-call': 'planId', 'unknown-tool-call': 'name',
  }).map(([kind, extra]) => [kind, `${toolFields} ${extra}`])),
});
const rootFields = {
  turn: 'id seq referenceId initiator startedAt endedAt outcome trigger foreground',
  terminal: 'terminalId owner canKill command args cwd outputBytes truncated exitStatus',
};
const children: Readonly<Record<string, string>> = {
  'turn:outcome': 'kind reason detail signInRequired guguReason said', 'turn:trigger': 'kind chatIds',
  'terminal:exitStatus': 'exitCode signal', 'item:exitStatus': 'exitCode signal',
};
const names = (value: string) => value.trim().split(/\s+/);
export function windowProjectionHeaderFieldAllowed(kind: 'turn' | 'item' | 'terminal', itemKind: string, field: string) {
  const [name, child, extra] = field.split('.');
  const allowed = kind === 'item' ? Object.hasOwn(WINDOW_PROJECTION_ITEM_FIELDS, itemKind)
    ? WINDOW_PROJECTION_ITEM_FIELDS[itemKind] : undefined : rootFields[kind];
  return !!allowed && extra === undefined && names(allowed).includes(name)
    && (child === undefined || child.length > 0 && names(children[`${kind}:${name}`] ?? '').includes(child));
}
export const windowProjectionHeaderSchema = z.strictObject({
  target, values: z.record(z.string().max(128), scalar).refine(value => Object.keys(value).length <= 64
    && bytes(JSON.stringify(value)) <= 16384),
  fields: z.array(z.strictObject({ field: z.string().min(1).max(128), kind: fieldKind, handle })).max(64),
}).refine(header => {
  const required = header.target === 'turn' ? ['id', 'seq', 'referenceId', 'initiator']
    : header.target === 'item' ? ['id', 'seq', 'kind'] : ['terminalId', 'owner', 'canKill', 'truncated'];
  const seen = new Set(Object.keys(header.values));
  if (required.some(field => !seen.has(field))) return false;
  if (header.target !== 'terminal' && (!Number.isSafeInteger(header.values.seq) || Number(header.values.seq) < 0)) return false;
  if (header.target === 'turn' && !['user', 'agent'].includes(String(header.values.initiator))) return false;
  if (header.target === 'item' && header.values.kind === 'message' && !['user', 'assistant'].includes(String(header.values.role))) return false;
  for (const field of header.fields) { if (seen.has(field.field)) return false; seen.add(field.field); }
  return [...seen].every(field => windowProjectionHeaderFieldAllowed(header.target, String(header.values.kind), field));
}, 'Invalid canonical header vocabulary or identity');
export type WindowProjectionHeader = z.infer<typeof windowProjectionHeaderSchema>;
export const windowProjectionBodySlotSchema = z.enum(['text', 'outputText', 'rawOutput', 'rawInput', 'output']);
export type WindowProjectionBodySlot = z.infer<typeof windowProjectionBodySlotSchema>;
function bounded<T extends z.ZodType>(shape: T) {
  return shape.refine(value => bytes(JSON.stringify(value)) <= WINDOW_PROJECTION_OUTPUT_BYTES, 'Projection output exceeds its byte budget');
}
export const windowProjectionOpenSchema = bounded(z.strictObject({
  lease, position: windowLivePositionSchema, root: windowProjectionHeaderSchema,
  count: integer, next: handle.nullable(),
}).refine(value => value.root.target === 'turn' && value.root.values.referenceId === value.position.referenceId
  && value.root.values.seq === value.position.storedSeq && (value.count === 0) === (value.next === null)));
export type WindowProjectionOpen = z.infer<typeof windowProjectionOpenSchema>;
export const windowProjectionPageSchema = bounded(z.strictObject({
  lease, position: windowLivePositionSchema, ordinal: integer, entityId: id, parentEntityId: id.nullable(),
  header: windowProjectionHeaderSchema, hasChildren: z.boolean(),
  bodies: z.array(z.strictObject({ field: windowProjectionBodySlotSchema, handle })).max(3), next: handle.nullable(),
}).refine(row => {
  if (row.header.target === 'turn') return false;
  const allowed = row.header.target === 'terminal' ? ['output']
    : ['message', 'thinking'].includes(String(row.header.values.kind)) ? ['text']
    : String(row.header.values.kind).endsWith('-tool-call') ? ['outputText', 'rawOutput', 'rawInput'] : [];
  return new Set(row.bodies.map(body => body.field)).size === row.bodies.length
    && row.bodies.every(body => allowed.includes(body.field));
}));
export type WindowProjectionPage = z.infer<typeof windowProjectionPageSchema>;
/** offset is decoded UTF-8 bytes. Object keys and nested values are opaque
 * fields; their real kinds survive even when the container has no members. */
export const windowProjectionFieldPageSchema = bounded(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('body'), offset: integer,
    text: z.string().max(WINDOW_PROJECTION_BODY_BYTES).refine(value => bytes(value) <= WINDOW_PROJECTION_BODY_BYTES),
    next: handle.nullable() }),
  z.strictObject({ kind: z.literal('values'), containerKind: z.enum(['array', 'object']), entries: z.array(z.strictObject({
    ordinal: integer, key: handle.nullable(), value: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('scalar'), value: primitive }),
      z.strictObject({ kind: z.literal('field'), fieldKind, handle }),
    ]),
  })).max(WINDOW_PROJECTION_MEMBERS), next: handle.nullable() }),
]).refine(page => page.kind !== 'values' || page.entries.every((entry, index) =>
  (page.containerKind === 'array' ? entry.key === null : entry.key !== null)
  && (index === 0 || entry.ordinal === page.entries[index - 1].ordinal + 1))));
export type WindowProjectionFieldPage = z.infer<typeof windowProjectionFieldPageSchema>;

export const windowProjectionReadRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...owner, kind: z.literal('open'), position: windowLivePositionSchema }),
  z.strictObject({ ...owner, kind: z.literal('page'), cursor: handle }),
  z.strictObject({ ...owner, kind: z.literal('release'), lease }),
]);
export const windowProjectionBodyReadRequestSchema = z.strictObject({ ...owner, handle });
export type WindowProjectionReadRequest = z.infer<typeof windowProjectionReadRequestSchema>;
export type WindowProjectionBodyReadRequest = z.infer<typeof windowProjectionBodyReadRequestSchema>;
export const windowProjectionReadValueSchema = z.union([windowProjectionOpenSchema, windowProjectionPageSchema, z.void()]);
export type WindowProjectionReadValue = z.infer<typeof windowProjectionReadValueSchema>;
function result<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: windowLiveErrorSchema })]);
}
export const windowProjectionReadResultSchema = result(windowProjectionReadValueSchema);
export const windowProjectionBodyReadResultSchema = result(windowProjectionFieldPageSchema);
/** Host binds both routes to sender + subscription UUID. Retain the opened
 * resident version until explicit release or subscription close, never ACK.
 * Failures do not authorize a retry, a new source or a replacement version. */
export interface WindowProjectionApi {
  read(input: WindowProjectionReadRequest): Promise<WindowLiveResult<WindowProjectionReadValue>>;
  readBody(input: WindowProjectionBodyReadRequest): Promise<WindowLiveResult<WindowProjectionFieldPage>>;
}
