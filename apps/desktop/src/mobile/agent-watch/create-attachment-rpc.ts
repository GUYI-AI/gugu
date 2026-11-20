import { attachmentSha256 } from '@gugu/core/cloud/attachmentsApi'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { sniffFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { callDeviceRpc } from '@/lib/deviceRpc'
import { placeTaskAttachment } from '@/lib/attachmentsEndpoint'
import { getCurrentAuthUserId } from '@/lib/supabase'
import { SESSION_HOST_RPC } from '@/session/shared/lib/ipc/session-host-device-frames'
import { invokePhoneHost } from '../local-agent/phoneHostRpc'
import { SessionpageRpcError } from '../../components/session-watch/sessionpage-rpc'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol'
import type { CreationAttachmentPorts } from './create-attachment-submission'

/** Dedicated names make an older host refuse instead of silently creating a caption-only task. */
export function creationAttachmentPorts(deviceId: string, phoneHost: boolean, ownerId: string): CreationAttachmentPorts {
  const call = async (method: string, input: unknown, requestId: string): Promise<SessionCreateAttachmentDraftResult> => {
    const channel = `sessionTimeline.${method}`
    if (phoneHost) return invokePhoneHost(deviceId, channel, [input], requestId, 180_000)
    type Answer = { ok: true; value: SessionCreateAttachmentDraftResult } | { ok: false; error: { code: string; message: string } }
    const reply = await callDeviceRpc<{ value: Answer }>(deviceId, SESSION_HOST_RPC.call,
      { channel, args: [input], protocol: REMOTE_PROTOCOL_VERSION }, { timeoutMs: 180_000 })
    if (reply.error) throw new SessionpageRpcError(reply.error.code, reply.error.message)
    const answer = reply.result?.value
    if (!answer) throw new SessionpageRpcError('host_update_required', translateSessionMessage('composer.attachmentHostUpdateRequired'))
    if (!answer.ok) throw new SessionpageRpcError(answer.error.code, answer.error.message)
    return answer.value
  }
  return {
    async assertAccount() {
      if (await getCurrentAuthUserId() !== ownerId) throw Object.assign(new Error('The account changed; this attachment task remains in its original draft'), { code: 'creation_attachments_account_changed' })
    },
    async describe(file) {
      return { name: file.name || 'file', sizeBytes: file.size, mimeType: await sniffFileMimeType(file), sha256: await attachmentSha256(file) }
    },
    create: (request) => call('sessionCreateAttachmentDraft', request, request.clientRequestId),
    place: (file, target, placement) => placeTaskAttachment(file, null, target, undefined, { placement }),
    admit: (input) => call('sessionAdmitCreatedAttachments', input, input.initialMessageId),
  }
}
