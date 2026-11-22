import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveWorkspace } from '@main/core/workspaces/resolve-workspace';
import { createAttachmentUploads } from '../files/attachment-uploads';
import { ATTACHMENT_UPLOAD_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import type { TranscriptMessage, TranscriptTurn } from '@gugu/session-core/acp/client';
import { noteNativeConversationReplies } from './session-conversation-read';
import { readCurrentTurnIdentity } from './session-activity-source';
import { nativePublicationContext } from './native-publication-host';
import { prepareNativePublicationTurn } from './native-publication-turn';
import { appendJournalTurn, journalTurns } from './session-journal';

export type OwnerNotificationInput = {
  request_id: string; agent_user_id: string; text: string;
  file?: { path: string; name: string; mime_type: string };
};
type Context = { sessionId: string; workspaceId: string };
const uploads = createAttachmentUploads();
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function snapshotFile(root: string, input: OwnerNotificationInput): Promise<NonNullable<TranscriptMessage['ownerNotification']>['files']> {
  if (!input.file) return undefined;
  if (!isAbsolute(input.file.path)) throw new Error('owner notification file_path must be absolute');
  const source = await open(input.file.path, 'r');
  let bytes: Buffer;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('owner notification file must be a regular file of at most 25 MiB');
    bytes = await source.readFile();
    const after = await source.stat();
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('owner notification file changed while reading');
  } finally { await source.close(); }
  const spec = { uploadId: `owner-notify-${input.request_id}`, itemId: input.request_id, name: input.file.name, size: bytes.length, sha256: hash(bytes) };
  const begun = await uploads.begin(root, spec);
  for (let offset = begun.received; offset < bytes.length; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES);
    await uploads.write(root, { ...spec, offset, data: chunk.toString('base64'), chunkSha256: hash(chunk) });
  }
  const saved = await uploads.commit(root, spec);
  return [{ path: join(root, saved.workspacePath), name: input.file.name, mimeType: input.file.mime_type, sizeBytes: bytes.length, sha256: spec.sha256 }];
}

// One session's notifications commit one after another: the retry of a request finds the first one written.
const tails = new Map<string, Promise<unknown>>();
function serially<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const next = (tails.get(sessionId) ?? Promise.resolve()).then(task, task);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(sessionId, tail);
  void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
  return next;
}

const notificationOf = (turn: TranscriptTurn) => {
  const item = turn.items[0];
  return item?.kind === 'message' ? item.ownerNotification : undefined;
};

/**
 * The host supplies the caller coordinates and revalidates identity immediately before committing. The notification
 * is a turn of the session's journal (the timeline reads it there, among the agent's turns by time); its request id
 * names it, so a retry finds it.
 */
export async function commitOwnerNotification(context: Context, input: OwnerNotificationInput, beforeCommit: () => Promise<void>, signal?: AbortSignal) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id)
    || typeof input.text !== 'string' || (!input.text.trim() && !input.file)) throw new Error('Invalid owner notification');
  const row = db.select().from(sessions).where(eq(sessions.id, context.sessionId)).get();
  if (!row || row.archivedAt || row.workspaceId !== context.workspaceId) throw new Error('The sending native session is missing, archived, or no longer bound to this workspace');
  if (row.runtime !== 'acp') throw new Error('This PTY session does not support native owner notifications. This message was not delivered to your owner.');
  const workspace = input.file ? await resolveWorkspace(context.workspaceId) : null;
  if (input.file && !workspace) throw new Error('The sending session workspace is not mounted');
  const sourceId = `owner-notify:${input.request_id}`;
  const requestHash = hash(Buffer.from(JSON.stringify([input.agent_user_id, input.text, input.file?.path, input.file?.name, input.file?.mime_type])));
  const receipt = (files: NonNullable<TranscriptMessage['ownerNotification']>['files']) =>
    ({ status: 'sent' as const, message_id: input.request_id, session_id: context.sessionId, ...(files?.[0] ? { file_name: files[0].name } : {}) });
  return serially(context.sessionId, async () => {
    signal?.throwIfAborted();
    await beforeCommit();
    const existing = (await journalTurns(context.sessionId)).find(turn => turn.id === sourceId);
    if (existing) {
      const previous = notificationOf(existing);
      if (previous?.requestHash !== requestHash) throw new Error('Owner notification request_id was already committed with different content');
      return receipt(previous.files);
    }
    const sourceTurnId = await readCurrentTurnIdentity(context.sessionId);
    const files = input.file ? await snapshotFile(workspace!.path, input) : undefined;
    await beforeCommit();
    signal?.throwIfAborted();
    const publication = await nativePublicationContext(context.sessionId, true);
    if (publication && publication.agentUserId !== input.agent_user_id) throw new Error('Owner notification identity changed before publication');
    const at = Date.now();
    const prepared = prepareNativePublicationTurn({ sessionId: context.sessionId, rowId: sourceId, source: 'live', context: publication, turn: { id: sourceId, seq: 0, initiator: 'agent', trigger: { kind: 'agent' }, startedAt: at, endedAt: at,
      outcome: { kind: 'done' }, items: [{ kind: 'message', id: `${sourceId}:message:${input.request_id}`, seq: 0, role: 'assistant',
        text: input.text || files![0]!.name, at, ownerNotification: { requestId: input.request_id, requestHash, ...(sourceTurnId ? { sourceTurnId } : {}), ...(files ? { files } : {}) } }] } }, db);
    const publish = db.transaction(tx => {
      const current = tx.select().from(sessions).where(eq(sessions.id, context.sessionId)).get();
      if (!current || current.archivedAt || current.workspaceId !== context.workspaceId) throw new Error('The sending session changed before the owner notification committed');
      prepared.commit(tx);
      return noteNativeConversationReplies(context.sessionId, prepared.turn, prepared.turn, tx);
    });
    await appendJournalTurn(context.sessionId, prepared.turn);
    publish?.();
    return receipt(files);
  });
}

/** Notification snapshots are authorized by their actual durable session message, not by arbitrary paths. */
export async function ownerNotificationFile(sessionId: string, path: string): Promise<boolean> {
  return (await journalTurns(sessionId)).some(turn => notificationOf(turn)?.files?.some(file => file.path === path));
}
