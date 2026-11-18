import { creationAttachmentIntentIdentity, validateCreationAttachmentRequest, verifyCreatedAttachmentPlacements } from '../../../packages/session-core/src/session-record/creation-attachment-protocol.ts'
import { phoneTaskInputReceipt } from './phone-agent-task-api.mjs'

const failure = (message) => Object.assign(new Error(message), { code: 'attachment_creation_unverified' })
const placementKey = (request, placements) => {
  if (!Array.isArray(placements) || placements.length !== request.attachments.length
    || new Set(placements.map(p => p?.attachmentId)).size !== placements.length) throw failure('The complete original placement set is required')
  return JSON.stringify(request.attachments.map(a => {
    const p = placements.find(p => p?.attachmentId === a.id)
    if (!p?.file?.itemId || !Number.isSafeInteger(p.file.version) || p.file.version < 1) throw failure('The original pinned file versions are required')
    return [a.id, p.file.itemId, p.file.version]
  }))
}

/** The phone's existing owner-scoped host journal owns both the creation saga and this pending first input. */
export function createPhoneAttachmentCreation({ ownerId, deviceId, store, provision, task, verify, resolve, send, isReady }) {
  if (store.state.ownerId !== ownerId) throw failure('The phone journal belongs to another owner')
  const changing = new Map()
  const serial = (key, work) => {
    const next = (changing.get(key) ?? Promise.resolve()).then(work, work)
    changing.set(key, next)
    void next.finally(() => { if (changing.get(key) === next) changing.delete(key) }).catch(() => undefined)
    return next
  }
  const ready = (signal) => { signal?.throwIfAborted(); if (!isReady()) throw failure('The original phone host is no longer ready') }
  const receipt = (entry) => ({ ...entry.created, attachmentDraft: { protocol: 1,
    clientRequestId: entry.request.clientRequestId, initialMessageId: entry.request.initialMessageId,
    state: entry.admitted ? 'admitted' : 'awaiting-placement' } })
  const current = async (entry, signal) => {
    ready(signal)
    const actual = await task(entry.created.conversationId)
    if (actual.agentUserId !== entry.created.attachmentTarget.agentUserId || actual.chatId !== entry.created.attachmentTarget.chatId) throw failure('The original task attachment target changed')
    await verify(actual.agentUserId)
    ready(signal)
    return actual
  }
  const create = async (original, signal) => {
    const request = structuredClone(original)
    validateCreationAttachmentRequest(request)
    const fingerprint = creationAttachmentIntentIdentity(ownerId, deviceId, request)
    return serial(request.clientRequestId, async () => {
      ready(signal)
      store.state.attachmentCreations ??= {}
      let entry = store.state.attachmentCreations[request.clientRequestId]
      if (entry && (entry.version !== 1 || typeof entry.admitted !== 'boolean' || entry.ownerId !== ownerId || entry.deviceId !== deviceId || entry.fingerprint !== fingerprint)) throw failure('The original creation intent cannot be changed')
      if (!entry) store.state.attachmentCreations[request.clientRequestId] = entry = {
        version: 1, ownerId, deviceId, fingerprint, request: structuredClone(request), created: null, admitted: false,
      }
      // A previous failed save is not an acknowledgement. Persist again before any provisioning RPC.
      await store.save()
      if (!entry.created) {
        const created = await provision(entry.request)
        ready(signal)
        if (!created?.conversationId || !created?.projectId || !created?.attachmentTarget?.agentUserId || !created?.attachmentTarget?.chatId) throw failure('The phone did not return the actual task attachment target')
        entry.created = created
        await store.save()
      }
      await current(entry, signal)
      await store.save()
      return receipt(entry)
    })
  }
  const admit = (original, signal) => {
    const input = structuredClone(original)
    return serial(input?.clientRequestId, async () => {
      ready(signal)
      const entry = store.state.attachmentCreations?.[input?.clientRequestId]
      if (!entry?.created || entry.version !== 1 || typeof entry.admitted !== 'boolean' || entry.ownerId !== ownerId || entry.deviceId !== deviceId
        || input.conversationId !== entry.created.conversationId || input.initialMessageId !== entry.request.initialMessageId) throw failure('The original registered creation is required')
      const key = placementKey(entry.request, input.placements)
      if (entry.placementKey && entry.placementKey !== key) throw failure('The original placement identities cannot be replaced')
      const actual = await current(entry, signal)
      const payload = (files) => ({ conversationId: entry.created.conversationId, clientRequestId: entry.request.initialMessageId,
        text: entry.request.prompt, files, requiresCompleteFiles: true,
        expectedFileDigests: files.map((file, i) => ({ itemId: file.itemId, version: file.version,
          sha256: entry.request.attachments[i].sha256, sizeBytes: entry.request.attachments[i].sizeBytes })) })
      // An accepted input is confirmed before re-reading a file whose permission may have changed after a lost ACK.
      if (entry.prepared) {
        const prior = phoneTaskInputReceipt(store, ownerId, actual.agentUserId, payload(entry.prepared))
        if (prior === 'uncertain') throw failure('The original input receipt conflicts with this creation')
        if (prior === 'accepted') {
          await send(payload(entry.prepared)) // Confirms the existing durable job, without re-enqueueing it.
          entry.admitted = true; await store.save(); return receipt(entry)
        }
        if (entry.admitted) { await store.save(); return receipt(entry) }
      }
      const files = await verifyCreatedAttachmentPlacements({ ownerId, deviceId, conversationId: entry.created.conversationId,
        request: entry.request, target: entry.created.attachmentTarget }, { ownerId, deviceId }, input,
      (file, agentUserId) => resolve(actual, file, agentUserId, signal))
      ready(signal)
      entry.prepared = files; entry.placementKey = key
      await store.save()
      ready(signal)
      const result = await send(payload(files))
      if (result?.admission !== 'accepted') throw failure('The host has not acknowledged the first input')
      entry.admitted = true
      await store.save()
      return receipt(entry)
    })
  }
  return async (channel, args, source = {}) => {
    if (channel === 'sessionTimeline.sessionCreateAttachmentDraft') return { value: await create(args[0], source.signal) }
    if (channel === 'sessionTimeline.sessionAdmitCreatedAttachments') return { value: await admit(args[0], source.signal) }
    return null
  }
}
