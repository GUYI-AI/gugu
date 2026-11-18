import type { TurnFileRef } from '../acp/models/turn-files';
import type { SessionpageSessionCreateRequest, SessionpageSessionCreateResult } from './contract';

export type CreationAttachmentManifest = {
  id: string; name: string; sizeBytes: number; mimeType: string; sha256: string;
};
/** Separate RPC methods: an old host must refuse, rather than ignore new fields and send only the caption. */
export type SessionCreateAttachmentDraftRequest = Omit<SessionpageSessionCreateRequest, 'clientRequestId' | 'initialMessageId'> & {
  clientRequestId: string; initialMessageId: string; attachments: CreationAttachmentManifest[];
};
export type CreationAttachmentTarget = { agentUserId: string; chatId: string };
export type CreationAttachmentDraftReceipt = {
  protocol: 1; clientRequestId: string; initialMessageId: string; state: 'awaiting-placement' | 'admitted';
};
export type SessionCreateAttachmentDraftResult = SessionpageSessionCreateResult & {
  attachmentTarget: CreationAttachmentTarget; attachmentDraft: CreationAttachmentDraftReceipt;
};
export type SessionAdmitCreatedAttachmentsRequest = {
  conversationId: string; clientRequestId: string; initialMessageId: string;
  placements: { attachmentId: string; file: TurnFileRef }[];
};
/** These bindings come from the host's durable creation record and authenticated connection, never request booleans. */
export type RegisteredCreationAttachments = {
  ownerId: string; deviceId: string; conversationId: string;
  request: SessionCreateAttachmentDraftRequest; target: CreationAttachmentTarget;
};
/** A fact obtained by resolving the pinned version as the actual task agent and checking its DM membership. */
export type ResolvedCreationAttachment = {
  agentUserId: string; chatId: string; itemId: string; version: number; sizeBytes: number; sha256: string;
};

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`creation-attachments: ${reason}`);
}

export function validateCreationAttachmentRequest(request: SessionCreateAttachmentDraftRequest): void {
  assert(nonempty(request.clientRequestId) && nonempty(request.initialMessageId), 'stable request and message identities are required');
  assert(typeof request.prompt === 'string' && nonempty(request.harness), 'creation input is incomplete');
  assert(Array.isArray(request.attachments) && request.attachments.length > 0, 'an attachment manifest is required');
  const ids = new Set<string>();
  for (const file of request.attachments) {
    assert(file && nonempty(file.id) && !ids.has(file.id), 'attachment identities must be unique');
    ids.add(file.id);
    assert(nonempty(file.name) && !file.name.includes('\0') && nonempty(file.mimeType), 'file metadata is incomplete');
    assert(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0, 'invalid file size');
    assert(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'a complete lowercase SHA-256 is required');
  }
}

/** Bind every creation option, including future options, to the same owner/device intent. Not for logging. */
export function creationAttachmentIntentIdentity(ownerId: string, deviceId: string, request: SessionCreateAttachmentDraftRequest): string {
  validateCreationAttachmentRequest(request);
  assert(nonempty(ownerId) && nonempty(deviceId), 'authenticated owner and device are required');
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
    return value;
  };
  return JSON.stringify([ownerId, deviceId, sorted(request)]);
}

/** A missing/old receipt cannot be interpreted as a successful two-phase creation. */
export function assertCreationAttachmentReceipt(request: SessionCreateAttachmentDraftRequest, result: SessionCreateAttachmentDraftResult): void {
  const receipt = result?.attachmentDraft, target = result?.attachmentTarget;
  assert(nonempty(result?.conversationId) && nonempty(result?.projectId), 'created task identity is missing');
  assert(receipt?.protocol === 1 && receipt.clientRequestId === request.clientRequestId
    && receipt.initialMessageId === request.initialMessageId, 'host did not acknowledge this attachment protocol');
  assert(receipt.state === 'awaiting-placement' || receipt.state === 'admitted', 'unknown admission state');
  assert(nonempty(target?.agentUserId) && nonempty(target?.chatId), 'actual task attachment target is missing');
}

/**
 * Read every authoritative placement before any admission. Returns only pinned file identities, with no caller path
 * hints. The caller must still use the durable request/ordinary-input receipt for once-only admission and recovery.
 */
export async function verifyCreatedAttachmentPlacements(
  registered: RegisteredCreationAttachments,
  authenticated: { ownerId: string; deviceId: string },
  input: SessionAdmitCreatedAttachmentsRequest,
  resolve: (file: TurnFileRef, agentUserId: string) => Promise<ResolvedCreationAttachment>,
): Promise<TurnFileRef[]> {
  validateCreationAttachmentRequest(registered.request);
  assert(nonempty(registered.ownerId) && nonempty(registered.deviceId) && nonempty(registered.conversationId), 'registered creation binding is incomplete');
  assert(authenticated.ownerId === registered.ownerId && authenticated.deviceId === registered.deviceId, 'creation owner/device changed');
  assert(input.conversationId === registered.conversationId && input.clientRequestId === registered.request.clientRequestId
    && input.initialMessageId === registered.request.initialMessageId, 'creation identity changed');
  assert(nonempty(registered.target.agentUserId) && nonempty(registered.target.chatId), 'registered task target is missing');
  assert(Array.isArray(input.placements) && input.placements.length === registered.request.attachments.length, 'placement set is incomplete');
  const byId = new Map<string, TurnFileRef>();
  for (const placement of input.placements) {
    assert(placement && nonempty(placement.attachmentId) && !byId.has(placement.attachmentId), 'duplicate placement identity');
    assert(placement.file && nonempty(placement.file.itemId) && Number.isSafeInteger(placement.file.version)
      && placement.file.version > 0, 'placement must pin an actual file version');
    byId.set(placement.attachmentId, placement.file);
  }
  const verified: TurnFileRef[] = [];
  for (const attachment of registered.request.attachments) {
    const file = byId.get(attachment.id);
    assert(file, 'placement does not belong to the registered manifest');
    // No path/workspacePath supplied by the renderer crosses the authoritative resolver boundary.
    const pinned = { itemId: file.itemId, version: file.version, name: attachment.name,
      mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
    const fact = await resolve(pinned, registered.target.agentUserId);
    assert(fact.agentUserId === registered.target.agentUserId && fact.chatId === registered.target.chatId, 'file is not placed in the actual task DM');
    assert(fact.itemId === pinned.itemId && fact.version === pinned.version, 'resolved file version changed');
    assert(fact.sizeBytes === attachment.sizeBytes && fact.sha256 === attachment.sha256, 'placed bytes do not match the registered manifest');
    verified.push(pinned);
  }
  return verified;
}
