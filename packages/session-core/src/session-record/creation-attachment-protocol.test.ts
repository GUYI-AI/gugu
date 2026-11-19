import { describe, expect, it, vi } from 'vitest';
import {
  assertCreationAttachmentReceipt, creationAttachmentIntentIdentity, validateCreationAttachmentRequest,
  verifyCreatedAttachmentPlacements, type RegisteredCreationAttachments, type SessionAdmitCreatedAttachmentsRequest,
  type SessionCreateAttachmentDraftResult,
} from './creation-attachment-protocol';

const manifest = { id: 'attachment-1', name: 'photo.png', mimeType: 'image/png', sizeBytes: 12, sha256: 'a'.repeat(64) };
const request = { clientRequestId: 'attempt-1', initialMessageId: 'message-1', harness: 'codex', prompt: '', attachments: [manifest] };
const registered: RegisteredCreationAttachments = { ownerId: 'owner', deviceId: 'device', conversationId: 'task', request,
  target: { agentUserId: 'agent', chatId: 'agent-dm' } };
const authenticated = { ownerId: 'owner', deviceId: 'device' };
const file = { itemId: 'file-1', version: 2, name: manifest.name, mimeType: manifest.mimeType, sizeBytes: 12 };
const input: SessionAdmitCreatedAttachmentsRequest = { conversationId: 'task', clientRequestId: 'attempt-1', initialMessageId: 'message-1',
  placements: [{ attachmentId: manifest.id, file }] };
const fact = { agentUserId: 'agent', chatId: 'agent-dm', itemId: file.itemId, version: file.version, sizeBytes: 12, sha256: manifest.sha256 };

describe('two-phase creation attachment contract', () => {
  it('accepts a file-only first turn without fabricating text', () => {
    expect(() => validateCreationAttachmentRequest(request)).not.toThrow();
    expect(request.prompt).toBe('');
  });
  it.each([
    { clientRequestId: '' }, { initialMessageId: '' }, { attachments: [] },
    { attachments: [manifest, manifest] }, { attachments: [{ ...manifest, sizeBytes: -1 }] },
    { attachments: [{ ...manifest, sha256: 'incomplete' }] },
  ])('rejects an incomplete manifest/identity %j', change => {
    expect(() => validateCreationAttachmentRequest({ ...request, ...change })).toThrow('creation-attachments:');
  });
  it('binds the exact intent to owner/device and every creation option, independent of object key order', () => {
    const identity = creationAttachmentIntentIdentity('owner', 'device', request);
    expect(creationAttachmentIntentIdentity('owner', 'device', { ...request, model: undefined })).toBe(identity);
    expect(creationAttachmentIntentIdentity('other-owner', 'device', request)).not.toBe(identity);
    expect(creationAttachmentIntentIdentity('owner', 'other-device', request)).not.toBe(identity);
    expect(creationAttachmentIntentIdentity('owner', 'device', { ...request, model: 'native-model' })).not.toBe(identity);
    expect(creationAttachmentIntentIdentity('owner', 'device', { ...request, attachments: [{ ...manifest, sha256: 'b'.repeat(64) }] })).not.toBe(identity);
  });
  it('requires a versioned receipt with the actual task target', () => {
    const receipt: SessionCreateAttachmentDraftResult = { conversationId: 'task', projectId: 'project', title: 'photo', attachmentTarget: registered.target,
      attachmentDraft: { protocol: 1, clientRequestId: request.clientRequestId, initialMessageId: request.initialMessageId, state: 'awaiting-placement' } };
    expect(() => assertCreationAttachmentReceipt(request, receipt)).not.toThrow();
    expect(() => assertCreationAttachmentReceipt(request, { conversationId: 'task', projectId: 'project', title: 'old host' } as SessionCreateAttachmentDraftResult)).toThrow();
    expect(() => assertCreationAttachmentReceipt(request, { ...receipt, attachmentDraft: { ...receipt.attachmentDraft, clientRequestId: 'other' } })).toThrow();
    expect(() => assertCreationAttachmentReceipt(request, { ...receipt, attachmentTarget: { ...registered.target, chatId: '' } })).toThrow();
  });
  it('resolves the pinned version as the actual agent and discards all caller path hints', async () => {
    const resolve = vi.fn().mockResolvedValue(fact);
    const files = await verifyCreatedAttachmentPlacements(registered, authenticated, { ...input,
      placements: [{ attachmentId: manifest.id, file: { ...file, path: '/untrusted', workspacePath: '.gugu/attachments/untrusted' } }] }, resolve);
    expect(files).toEqual([file]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(file, 'agent');
  });
  it.each([
    { ownerId: 'other', deviceId: 'device' }, { ownerId: 'owner', deviceId: 'other' },
  ])('rejects a changed owner/device before resolving any file %j', async scope => {
    const resolve = vi.fn();
    await expect(verifyCreatedAttachmentPlacements(registered, scope, input, resolve)).rejects.toThrow('owner/device');
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    { conversationId: 'other' }, { clientRequestId: 'other' }, { initialMessageId: 'other' },
    { placements: [] }, { placements: [{ attachmentId: 'unknown', file }] },
  ])('rejects retargeted or incomplete admission %j', async change => {
    await expect(verifyCreatedAttachmentPlacements(registered, authenticated, { ...input, ...change }, vi.fn().mockResolvedValue(fact))).rejects.toThrow();
  });
  it.each([
    { agentUserId: 'other' }, { chatId: 'other-dm' }, { itemId: 'other' }, { version: 3 }, { sizeBytes: 13 }, { sha256: 'b'.repeat(64) },
  ])('rejects a mismatching authoritative placement fact %j', async change => {
    await expect(verifyCreatedAttachmentPlacements(registered, authenticated, input, async () => ({ ...fact, ...change }))).rejects.toThrow();
  });
  it('propagates resolver permission failures without converting them into success or an empty file list', async () => {
    const denied = Object.assign(new Error('not a member of the task DM'), { code: 'EACCES' });
    await expect(verifyCreatedAttachmentPlacements(registered, authenticated, input, async () => { throw denied; })).rejects.toBe(denied);
  });
  it('returns no partial admission payload when the last attachment is unavailable', async () => {
    const second = { ...manifest, id: 'attachment-2', name: 'second.png' };
    const resolve = vi.fn().mockResolvedValueOnce(fact).mockRejectedValueOnce(new Error('bytes pending'));
    await expect(verifyCreatedAttachmentPlacements({ ...registered, request: { ...request, attachments: [manifest, second] } }, authenticated,
      { ...input, placements: [...input.placements, { attachmentId: second.id, file: { ...file, itemId: 'file-2' } }] }, resolve)).rejects.toThrow('bytes pending');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
