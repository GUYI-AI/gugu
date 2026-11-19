import type { SessionpageSessionCreateRequest, TurnFileRef } from '@gugu/session-core/session-record/contract'
import { assertCreationAttachmentReceipt, type SessionCreateAttachmentDraftRequest, type SessionCreateAttachmentDraftResult,
  type SessionAdmitCreatedAttachmentsRequest } from '@gugu/session-core/session-record/creation-attachment-protocol'
import type { TaskAttachmentTarget } from '@/lib/taskAttachmentTarget'
import type { TaskAttachmentPlacement } from '@/lib/attachmentsEndpoint'

export type CreationFile = { id: string; file: File }
export type CreationAttachmentPorts = {
  assertAccount(): Promise<void>
  describe(file: File): Promise<{ name: string; mimeType: string; sizeBytes: number; sha256: string }>
  create(request: SessionCreateAttachmentDraftRequest): Promise<SessionCreateAttachmentDraftResult>
  place(file: File, target: TaskAttachmentTarget, placement: TaskAttachmentPlacement): Promise<TurnFileRef>
  admit(input: SessionAdmitCreatedAttachmentsRequest): Promise<SessionCreateAttachmentDraftResult>
}
type Receipt = { request: SessionCreateAttachmentDraftRequest; result: SessionCreateAttachmentDraftResult }
type Attempt = {
  ownerId: string; deviceId: string; input: string; files: CreationFile[]
  request?: SessionCreateAttachmentDraftRequest; result?: SessionCreateAttachmentDraftResult
  placements: Map<string, { context: TaskAttachmentPlacement; file?: TurnFileRef }>
  running?: Promise<Receipt>
}
// Like the existing creation draft, this account-scoped memory survives route/device remounts and retains original Files.
const attempts = new Map<string, Attempt>()

function intent(request: SessionpageSessionCreateRequest & { attachments?: unknown }): string {
  const { clientRequestId: _requestId, initialMessageId: _messageId, attachments: _manifest, ...options } = request
  return JSON.stringify(Object.entries(options).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))
}

export function readAttachmentCreation(key: string): SessionCreateAttachmentDraftRequest | null {
  return attempts.get(key)?.request ?? null
}

/** A remounted page must reconnect to the captured device, even if its default run machine changed. */
export function readAttachmentCreationDevice(key: string): string | null {
  return attempts.get(key)?.deviceId ?? null
}

export function completeAttachmentCreation(key: string, request: SessionCreateAttachmentDraftRequest): void {
  const attempt = attempts.get(key)
  if (attempt?.request === request && attempt.result?.attachmentDraft.state === 'admitted') attempts.delete(key)
}

/** Creates once, places every file in that task's real DM, then asks the host to verify and admit the stable first turn. */
export function submitAttachmentCreation({ key, ownerId, deviceId, request, files, ports }: {
  key: string; ownerId: string; deviceId: string; request: SessionpageSessionCreateRequest
  files: readonly CreationFile[]; ports: CreationAttachmentPorts
}): Promise<Receipt> {
  let attempt = attempts.get(key)
  if (attempt) {
    if (attempt.ownerId !== ownerId || attempt.deviceId !== deviceId || attempt.input !== intent(request)
      || attempt.files.length !== files.length || attempt.files.some((entry, index) => entry.id !== files[index]?.id || entry.file !== files[index]?.file)) {
      return Promise.reject(Object.assign(new Error('The previous attachment task is still pending; retry its original device, options and files'), { code: 'creation_attachments_pending' }))
    }
    if (attempt.running) return attempt.running
  } else {
    if (!ownerId || !deviceId || !files.length) return Promise.reject(new Error('An account, device and original files are required'))
    attempt = { ownerId, deviceId, input: intent(request), files: files.map((entry) => ({ ...entry })), placements: new Map() }
    attempts.set(key, attempt)
  }
  const retained = attempt
  const run = async (): Promise<Receipt> => {
    await ports.assertAccount()
    if (!retained.request) {
      const attachments = await Promise.all(retained.files.map(async (entry) => ({ id: entry.id, ...await ports.describe(entry.file) })))
      retained.request = { ...request, clientRequestId: request.clientRequestId ?? crypto.randomUUID(),
        initialMessageId: request.initialMessageId ?? crypto.randomUUID(), attachments }
    }
    const original = retained.request
    if (!retained.result) {
      await ports.assertAccount()
      const created = await ports.create(original)
      assertCreationAttachmentReceipt(original, created)
      retained.result = created
    }
    const created = retained.result
    if (created.attachmentDraft.state === 'admitted') return { request: original, result: created }
    const target: TaskAttachmentTarget = { owner: ownerId, deviceId, sessionId: created.conversationId, chatId: created.attachmentTarget.chatId }
    const placements: SessionAdmitCreatedAttachmentsRequest['placements'] = []
    for (const entry of retained.files) {
      let placement = retained.placements.get(entry.id)
      if (!placement) { placement = { context: {} }; retained.placements.set(entry.id, placement) }
      if (!placement.file) {
        await ports.assertAccount()
        placement.file = await ports.place(entry.file, target, placement.context)
      }
      placements.push({ attachmentId: entry.id, file: placement.file })
    }
    await ports.assertAccount()
    const admitted = await ports.admit({ conversationId: created.conversationId, clientRequestId: original.clientRequestId,
      initialMessageId: original.initialMessageId, placements })
    assertCreationAttachmentReceipt(original, admitted)
    if (admitted.attachmentDraft.state !== 'admitted' || admitted.conversationId !== created.conversationId
      || admitted.projectId !== created.projectId || admitted.attachmentTarget.agentUserId !== created.attachmentTarget.agentUserId
      || admitted.attachmentTarget.chatId !== created.attachmentTarget.chatId) throw Object.assign(new Error('The host did not admit this task’s original attachment turn'), { code: 'creation_attachments_unconfirmed' })
    retained.result = admitted
    return { request: original, result: admitted }
  }
  const running = run()
  retained.running = running
  void running.finally(() => { if (retained.running === running) retained.running = undefined }).catch(() => {})
  return running
}
