import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  creationAttachmentIntentIdentity, assertCreationAttachmentReceipt, validateCreationAttachmentRequest,
  verifyCreatedAttachmentPlacements,
  type SessionCreateAttachmentDraftRequest, type SessionCreateAttachmentDraftResult,
  type SessionAdmitCreatedAttachmentsRequest, type CreationAttachmentTarget, type ResolvedCreationAttachment,
} from '@gugu/session-core/session-record/creation-attachment-protocol';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import { openCreationAttachmentJournal, attachmentCreationUnverified as unverified } from './creation-attachment-journal';

type Context = { ownerId: string; deviceId: string };
export type AttachmentCreationHostDeps = {
  root: () => string;
  context: () => Promise<Context>;
  create: (request: SessionCreateAttachmentDraftRequest, sessionId: string, beforeCommit: () => Promise<void>) => Promise<void>;
  task: (sessionId: string, ownerId: string) => Promise<{ projectId: string; title: string } | null>;
  address: (sessionId: string, projectId: string) => Promise<CreationAttachmentTarget>;
  resolve: (file: TurnFileRef, target: CreationAttachmentTarget, ownerId: string) => Promise<ResolvedCreationAttachment>;
  prior: (conversationId: string, text: string, messageId: string, files: TurnFileRef[]) => 'accepted' | 'uncertain' | null;
  send: (conversationId: string, text: string, messageId: string, files: TurnFileRef[]) => Promise<void>;
};

/** Host-only two-phase coordinator. It never accepts a caller's uploaded/admitted flag as evidence. */
export function createAttachmentCreationHost(deps: AttachmentCreationHostDeps) {
  const changing = new Map<string, Promise<unknown>>();
  async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (changing.get(key) ?? Promise.resolve()).then(work, work);
    changing.set(key, next);
    try { return await next; } finally { if (changing.get(key) === next) changing.delete(key); }
  }
  const current = async (expected: Context) => {
    if (!isDeepStrictEqual(expected, await deps.context())) throw unverified('The authenticated attachment owner/device changed');
  };
  const receipt = (result: SessionCreateAttachmentDraftResult, admitted: boolean): SessionCreateAttachmentDraftResult => ({ ...result,
    attachmentDraft: { ...result.attachmentDraft, state: admitted ? 'admitted' : 'awaiting-placement' } });
  const confirmed = (marker: { initialMessageId: string } | null, expected: string) => {
    if (marker !== null && (!marker || marker.initialMessageId !== expected)) throw unverified('The stored first-input acknowledgement is invalid');
    return marker !== null;
  };
  async function create(original: SessionCreateAttachmentDraftRequest) {
    const request = structuredClone(original);
    validateCreationAttachmentRequest(request);
    const context = await deps.context();
    const fingerprint = creationAttachmentIntentIdentity(context.ownerId, context.deviceId, request);
    return serial(fingerprint, async () => {
      const journal = await openCreationAttachmentJournal(deps.root(), context.ownerId, context.deviceId, request.clientRequestId);
      let intent = await journal.read('intent');
      if (!intent) {
        intent = { version: 1, ...context, fingerprint, conversationId: randomUUID(), request };
        await journal.append('intent', intent);
      }
      if (intent.version !== 1 || intent.ownerId !== context.ownerId || intent.deviceId !== context.deviceId
        || intent.fingerprint !== fingerprint || !intent.conversationId) throw unverified('The registered attachment creation intent changed');
      await current(context);
      let result = await journal.read('created');
      if (!result) {
        let task = await deps.task(intent.conversationId, context.ownerId);
        if (!task) {
          if (await journal.read('creating')) throw unverified('The original task creation outcome is unknown; it cannot be recreated');
          await deps.create(intent.request, intent.conversationId, async () => {
            await current(context);
            // Exclusive immutable claim. Another process must recover the same task, never create another one.
            if (!await journal.append('creating', { conversationId: intent!.conversationId })) {
              throw unverified('Another creation already owns the original task commit');
            }
          });
          task = await deps.task(intent.conversationId, context.ownerId);
        }
        if (!task) throw unverified('The original task has not been confirmed');
        await current(context);
        const target = await deps.address(intent.conversationId, task.projectId);
        await current(context);
        result = { conversationId: intent.conversationId, projectId: task.projectId, title: task.title,
          attachmentTarget: target, attachmentDraft: { protocol: 1, clientRequestId: request.clientRequestId,
            initialMessageId: request.initialMessageId, state: 'awaiting-placement' } };
        assertCreationAttachmentReceipt(request, result);
        await journal.append('created', result);
      }
      assertCreationAttachmentReceipt(request, result);
      await checkTask(result, context);
      return receipt(result, confirmed(await journal.read('admitted'), request.initialMessageId));
    });
  }
  async function checkTask(result: SessionCreateAttachmentDraftResult, context: Context) {
    await current(context);
    const task = await deps.task(result.conversationId, context.ownerId);
    if (!task || task.projectId !== result.projectId) throw unverified('The original task is unavailable to this owner');
    const target = await deps.address(result.conversationId, result.projectId);
    if (!isDeepStrictEqual(target, result.attachmentTarget)) throw unverified('The original task attachment target changed');
    await current(context);
  }
  async function admit(original: SessionAdmitCreatedAttachmentsRequest) {
    const input = structuredClone(original), context = await deps.context();
    return serial(JSON.stringify([context, input?.clientRequestId]), async () => {
      const journal = await openCreationAttachmentJournal(deps.root(), context.ownerId, context.deviceId, input.clientRequestId);
      const intent = await journal.read('intent'), result = await journal.read('created');
      if (!intent || !result || intent.ownerId !== context.ownerId || intent.deviceId !== context.deviceId
        || intent.request.clientRequestId !== input.clientRequestId || intent.request.initialMessageId !== input.initialMessageId
        || result.conversationId !== input.conversationId) throw unverified('The original registered attachment task is required');
      assertCreationAttachmentReceipt(intent.request, result);
      await checkTask(result, context);
      if (!Array.isArray(input.placements) || input.placements.length !== intent.request.attachments.length
        || new Set(input.placements.map(p => p?.attachmentId)).size !== input.placements.length) throw unverified('The complete original placement set is required');
      const key = JSON.stringify(intent.request.attachments.map(a => {
        const file = input.placements.find(p => p?.attachmentId === a.id)?.file;
        if (!file?.itemId || !Number.isSafeInteger(file.version) || file.version < 1) throw unverified('A pinned placement is required');
        return [a.id, file.itemId, file.version];
      }));
      let prepared = await journal.read('prepared');
      if (prepared && prepared.placementKey !== key) throw unverified('The original placement identities cannot be changed');
      if (prepared) {
        const prior = deps.prior(result.conversationId, intent.request.prompt, input.initialMessageId, prepared.files);
        if (prior === 'uncertain') throw unverified('The original first-input receipt conflicts');
        if (prior === 'accepted' || confirmed(await journal.read('admitted'), input.initialMessageId)) {
          await current(context);
          await journal.append('admitted', { initialMessageId: input.initialMessageId });
          return receipt(result, true);
        }
      }
      const files = await verifyCreatedAttachmentPlacements({ ...context, conversationId: result.conversationId,
        request: intent.request, target: result.attachmentTarget }, context, input,
      file => deps.resolve(file, result.attachmentTarget, context.ownerId));
      const strict = files.map((file, i) => ({ ...file, requiredPlacement: {
        chatId: result.attachmentTarget.chatId, sha256: intent.request.attachments[i].sha256,
      } }));
      await current(context);
      prepared = { placementKey: key, files: strict };
      await journal.append('prepared', prepared);
      await deps.send(result.conversationId, intent.request.prompt, input.initialMessageId, prepared.files);
      await current(context);
      await journal.append('admitted', { initialMessageId: input.initialMessageId });
      return receipt(result, true);
    });
  }
  return { create, admit };
}
