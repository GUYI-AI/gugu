import { AttachmentsError, attachmentRequest, uploadAttachmentPlan, type AttachmentsEndpoint, type AttachmentUploadPlan } from '@gugu/core/cloud/attachmentsApi'
import { ciphertextSize, createFileKey, transformFile } from '@gugu/core/shared/fileCipher'
import { createFileSink } from './fileSnapshot'
import { openProjectFileSource, type ProjectFileReader } from './projectFileHost'
import { readProjectFile, type ProjectFileVersionLookup } from './sessionpage/sessionpage-project-groups'

type Pending = { id: string; item_id: string; version: number; chat_id: string; host_device_id: string; relative_path: string; sha256: string; size_bytes: number; state: string }

/** Why a transfer failed, as a fixed reason: a file system error names a local path, so its message is never kept. */
function failureReason(error: unknown) {
  if (error instanceof AttachmentsError) return `${error.route} ${error.status} ${error.code}`
  if (!(error instanceof Error)) return 'unknown'
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : /^[\w -]+$/.test(error.message) ? error.message : error.name
}

/** Existing device events and reconnect reconciliation call this drain; no timer or new subscription. */
export function createProjectTransferHost(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>
  endpoint(): Promise<AttachmentsEndpoint>
  read: ProjectFileReader; tempRoot: string; env?: NodeJS.ProcessEnv; later: ProjectFileVersionLookup
}) {
  let running: Promise<void> | undefined, again = false
  const attempted = new Set<string>()
  const drain = async (): Promise<string[]> => {
    const identity = await deps.identity(), endpoint = await deps.endpoint()
    const { transfers } = await attachmentRequest(endpoint, 'file-pending', { device_id: identity.deviceId }) as { transfers: Pending[] }
    const active = new Set(transfers.map(row => row.id))
    for (const id of attempted) if (!active.has(id)) attempted.delete(id)
    const failed: string[] = []
    for (const row of transfers) {
      // After a crash an uploading generation has lost its key. Never overwrite it; its permit expires into the existing GC.
      if (row.state !== 'requested' || attempted.has(row.id)) continue
      let key: Uint8Array | undefined
      let sink: Awaited<ReturnType<typeof createFileSink>> | undefined
      try {
        const revision = await readProjectFile({ item_id: row.item_id, version: row.version }, identity.accountId, identity.deviceId, deps.env, deps.later)
        if (!revision || row.host_device_id !== identity.deviceId || row.chat_id !== revision.chat_id || row.relative_path !== revision.relative_path ||
          row.sha256 !== revision.sha256 || row.size_bytes !== revision.size_bytes) throw new Error('Transfer revision changed')
        const size = ciphertextSize(revision.size_bytes)
        // Authorization and quota reservation precede encryption, disk allocation and object upload.
        const permit = await attachmentRequest(endpoint, 'file-accept', { transfer_id: row.id, ciphertext_bytes: size }) as AttachmentUploadPlan
        if (permit.max_bytes !== size) throw new Error('Temporary upload permit size mismatch')
        attempted.add(row.id)
        key = await createFileKey()
        sink = await createFileSink(deps.tempRoot, size)
        const encrypted = await transformFile({ direction: 'encrypt', revision, key, sink, source: await openProjectFileSource(revision, deps.read) })
        if (JSON.stringify(await deps.identity()) !== JSON.stringify(identity)) throw new Error('File host account changed')
        await uploadAttachmentPlan(endpoint, permit, { bytes: await sink.blob(), name: 'file.enc', contentType: 'application/octet-stream' })
        // Key travels over the authenticated API only, never the object form, a device event or a log.
        await attachmentRequest(endpoint, 'file-commit', { transfer_id: row.id, ciphertext_bytes: size, ciphertext_sha256: encrypted.ciphertextSha256, key: Buffer.from(key).toString('base64') })
      } catch (error) { failed.push(`${row.id}: ${failureReason(error)}`) } finally { key?.fill(0); await sink?.abort() }
    }
    return failed
  }
  // A request that lands while a drain runs is not in the list that drain read: it reads the list once more when it is done.
  // `running` is cleared in the same step as the last look at `again`, so a later call starts a new run.
  const run = async () => {
    const failed: string[] = []
    while (again) { again = false; failed.push(...await drain().catch((error: unknown) => [`list: ${failureReason(error)}`])) }
    running = undefined
    if (failed.length) throw new Error(`${failed.length} project file transfer(s) failed; no unverified bytes were committed (${failed.join('; ')})`)
  }
  return () => {
    again = true
    return running ??= run()
  }
}
