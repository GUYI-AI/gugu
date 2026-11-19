import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { contentRequestId, uploadAttachmentBytes, type AttachmentsEndpoint } from '../../cloud/attachmentsApi'
import { commitSessionAttachment, revokeSessionAttachment, type SessionFileInput } from '../../cloud/sessionAttachments'
import { resolveAttachmentMimeType } from '../../shared/imageMime.mjs'
import { requireAgentFileAccess } from '../state/agentFileBoundary'

/** A file's sha256, read from disk in chunks: a large file is never held in memory. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function uploadSessionFile(endpoint: AttachmentsEndpoint, file: SessionFileInput, sender: {
  agentId: string; sessionId: string; recipients: string[]; expectedSha256?: string;
  beforeCommit?: () => Promise<void>; attachmentId?: string; stagingKey?: string; onStaged?: (key: string) => Promise<void>;
}) {
  const source = await requireAgentFileAccess(file.file_path)
  const info = await stat(source)
  if (!info.isFile()) throw new Error('Session attachment must be a regular file')
  const size = info.size
  const name = file.file_name ?? basename(file.file_path)
  const contentType = resolveAttachmentMimeType(name, file.mime_type)
  const sha = await fileSha256(source)
  // A file-backed Blob: this code never reads the whole file (fetch still buffers the body, about the file's size). It
  // refuses to be read once the file has changed, and the receipt is checked against this sha below. The server's upload
  // permit is the only size limit.
  const bytes = await openAsBlob(source, { type: contentType })
  if (sender.expectedSha256 && sender.expectedSha256 !== sha) throw new Error('Registered artifact changed before upload')
  const attachmentId = sender.attachmentId ?? randomUUID()
  // A stored handoff keeps its attachment ID while recovering the same bytes for the same recipients.
  const stagingKey = sender.stagingKey ?? await uploadAttachmentBytes(endpoint, { bytes, name, contentType }, {
    chat_id: null, as: sender.agentId,
    request_id: await contentRequestId('session', attachmentId, sender.agentId, sender.sessionId, [...sender.recipients].sort().join(','), sha, String(size)),
  })
  await sender.onStaged?.(stagingKey)
  await sender.beforeCommit?.()
  const args = { staging_key: stagingKey, attachment_id: attachmentId, sender_user_id: sender.agentId,
    sender_session_id: sender.sessionId, recipient_user_ids: sender.recipients, file_name: name, content_type: contentType }
  // Retry the same upload and id; never create another file to recover a lost receipt.
  let receipt
  for (let attempt = 0; ; attempt++) {
    try { receipt = await commitSessionAttachment(endpoint, args); break } catch (error) {
      if (attempt >= 2 || (typeof (error as { status?: number }).status === 'number' && (error as { status: number }).status < 500)) throw error
    }
  }
  if (receipt.sha256 !== sha || Number(receipt.size_bytes) !== size) {
    await revokeSessionAttachment(endpoint, args.attachment_id, sender.agentId)
    throw new Error('Uploaded session attachment differs from the original bytes')
  }
  return receipt
}

/** No recipient is admitted yet. Revoke only references created by this failed preparation. */
export async function uploadSessionFiles(endpoint: AttachmentsEndpoint, files: SessionFileInput[], sender: Parameters<typeof uploadSessionFile>[2]) {
  for (const file of files) {
    await requireAgentFileAccess(file.file_path)
    const info = await stat(file.file_path)
    if (!info.isFile()) throw new Error('Session attachment must be a regular file')
  }
  const refs = []
  try {
    for (const file of files) refs.push(await uploadSessionFile(endpoint, file, sender))
    return refs
  } catch (error) {
    const cleanup = await Promise.allSettled(refs.map(ref => revokeSessionAttachment(endpoint, ref.attachment_id, sender.agentId)))
    const failures = cleanup.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    if (failures.length) throw new AggregateError([error, ...failures.map(entry => entry.reason)], 'File preparation failed and reference revocation could not be confirmed')
    throw error
  }
}
