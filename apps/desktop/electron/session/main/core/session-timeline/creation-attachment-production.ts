import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { SessionCreateAttachmentDraftRequest, SessionAdmitCreatedAttachmentsRequest } from '@gugu/session-core/session-record/creation-attachment-protocol';
import { privateCreationAttachmentDirectory } from '@gugu/core/local/state/protectedPrivateStorage';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { saveToFileStore } from '@gugu/core/local/files/fileSnapshots';
import { resolveAccountFile } from '@main/core/extensions/account-token';
import { sessionIdentityHost } from '../sessions/session-identity-host';
import { sessionService } from '../sessions/session-service';
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner';
import { localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent';
import { createAttachmentCreationHost } from './creation-attachment-host';
import { attachmentCreationUnverified as unverified } from './creation-attachment-journal';
import { readCreationInputCustody } from './input-admission';
import { handoffCreationAttachmentInput } from './creation-attachment-handoff';

const host = createAttachmentCreationHost({
  root: privateCreationAttachmentDirectory,
  // OS account data is the existing durability boundary; HOME/GUGU_HOME are not proof.
  durabilityRoot: () => realpathSync(userInfo().homedir),
  context: async () => {
    const identity = sessionIdentityHost();
    if (!identity.attachmentCreationContext || !identity.ensureAgentAddress) throw unverified('This host does not support attachment-first creation');
    return identity.attachmentCreationContext();
  },
  create: async (request, sessionId, beforeCommit) => {
    const { createAttachmentDraft } = await import('./create-session');
    const result = await createAttachmentDraft(request, { sessionId,
      attachmentNames: request.attachments.map(file => file.name), beforeCommit });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  },
  task: async (sessionId, ownerId) => {
    const { readSessionRow } = await import('./service');
    const row = readSessionRow(sessionId);
    if (!row) return null;
    const agent = await localAgentForSession(sessionId, process.env);
    if (agent && agentOwnerUserId(agent) !== ownerId) throw unverified('The original task belongs to another owner or its ownership is unknown');
    // The persisted intent minted this exact task id before the transaction. No arbitrary session id is accepted.
    return { projectId: row.projectId, title: row.config?.agentDisplayName ?? row.legacyTitle ?? '' };
  },
  address: async (sessionId, projectId) => {
    const identity = sessionIdentityHost();
    if (!identity.ensureAgentAddress) throw unverified('This host cannot return the actual task attachment target');
    const mounted = await sessionService.provisionWorkspace(sessionId);
    if (!mounted.success) throw unverified(`The original task workspace is not ready: ${mounted.error.type}`);
    return identity.ensureAgentAddress({ projectId, sessionId });
  },
  resolve: async (file, target, ownerId) => {
    const resolved = await resolveAccountFile({ id: file.itemId }, target.agentUserId, { version: file.version });
    if (!resolved || resolved.status !== 'ready') throw unverified('The declared attachment is not readable by the task agent');
    try {
      if (resolved.reader.accountId !== ownerId || resolved.reader.actorId !== target.agentUserId
        || resolved.revision.chat_id !== target.chatId || resolved.revision.item_id !== file.itemId
        || resolved.revision.version !== file.version) throw unverified('The declared attachment is outside the actual task DM');
      // Read the complete authorized stream. Metadata or a successful upload response alone is not a byte proof.
      const saved = await saveToFileStore(resolved, resolveGuguHome(process.env), file.name);
      return { agentUserId: target.agentUserId, chatId: resolved.revision.chat_id, itemId: resolved.revision.item_id,
        version: resolved.revision.version, sizeBytes: saved.size_bytes, sha256: saved.sha256 };
    } finally { await resolved.dispose(); }
  },
  prior: (conversationId, text, clientMessageId, files) => {
    const evidence = readCreationInputCustody({ conversationId, text, clientMessageId, files });
    return evidence === 'custody' ? 'accepted' : evidence === 'absent' ? null : 'uncertain';
  },
  send: async (conversationId, text, clientMessageId, files, expected) => {
    const identity = sessionIdentityHost();
    await handoffCreationAttachmentInput(expected, async () => {
      if (!identity.attachmentCreationContext) throw unverified('The original attachment owner context is unavailable');
      return identity.attachmentCreationContext();
    }, async () => {
      const [{ send }, { sessionLife }] = await Promise.all([import('./service'), import('../sessions/session-life')]);
      return {
        capture: () => {
          const assertOwner = sessionLife().inputOwnerFence(expected.ownerId);
          return () => {
            if (identity !== sessionIdentityHost()) throw unverified('The original attachment host changed');
            assertOwner();
          };
        },
        send: async (assertOwner) => {
          const result = await send({ conversationId, text, clientMessageId, files }, assertOwner);
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          if (result.value.admission !== 'accepted') throw unverified('The original first input is not confirmed');
        },
      };
    });
  },
});

async function reply<T>(work: () => Promise<T>) {
  try { return { ok: true as const, value: await work() }; }
  catch (error) { return { ok: false as const, error: {
    code: (error as { code?: string }).code ?? 'attachment_creation_unverified',
    message: error instanceof Error ? error.message : String(error),
  } }; }
}
export const createAttachmentDraft = (request: SessionCreateAttachmentDraftRequest) => reply(() => host.create(request));
export const admitCreatedAttachments = (request: SessionAdmitCreatedAttachmentsRequest) => reply(() => host.admit(request));
