import { createDeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import type { FileContext, FileRevision } from '@gugu/core/shared/fileResolver'
import { attachSshDeviceRpcPipe, type SharedSshLinks } from './device-rpc-requester'
import { PROJECT_FILE_READ, openProjectFileSource, snapshotProjectFile, type ProjectFileChunk, type ProjectFileReader } from './projectFileHost'

export type HeldFileSshLinks = Pick<SharedSshLinks, 'tap' | 'send'> & {
  /** Real owner SSH mappings only; tunnels and connections from another account are excluded. */
  ownedOpen(deviceId: string, accountId: string): Promise<boolean>
}

export function ownSshFileProvider(links: HeldFileSshLinks, tempRoot: string) {
  return async (revision: FileRevision, context: FileContext) => {
    const deviceId = revision.host_device_id!, accountId = context.actor.accountId
    if (context.actor.actorId !== accountId || revision.host_account_id !== accountId || !await links.ownedOpen(deviceId, accountId)) return null
    const connect = (signal?: AbortSignal) => {
      const requester = createDeviceRpcRequester({ userId: async () => accountId, openPipe: async (device, handlers) => {
        if (!await links.ownedOpen(device, accountId)) throw new Error('Owner SSH link is no longer held')
        return attachSshDeviceRpcPipe(links, device, handlers)
      } })
      const read = async (request: Parameters<ProjectFileReader>[0]) => {
        if (!await links.ownedOpen(deviceId, accountId)) throw new Error('Owner SSH link is no longer held')
        const response = await requester.call(deviceId, PROJECT_FILE_READ, request, { timeoutMs: 30_000, signal })
        if (response.error) throw new Error(`File read refused: ${response.error.code}`)
        return response.result as ProjectFileChunk
      }
      return { read, close: () => requester.closeAll() }
    }
    const owner = connect(context.signal)
    let held = false
    try {
      if (context.download) {
        const source = await openProjectFileSource(revision, owner.read)
        held = true
        return { ...source, async dispose() { try { await source.dispose() } finally { owner.close() } } }
      }
      if (!context.backend || !context.reads) return await snapshotProjectFile(revision, owner.read, tempRoot, context.signal, context.progress)
      // Probe this grant's immutable binding even when a different reader already obtained the same bytes.
      await (await openProjectFileSource(revision, owner.read)).dispose()
      return await context.reads.acquire(context.backend, 'ssh', revision, context, async transfer => {
        const shared = connect(transfer.signal)
        try { return await snapshotProjectFile(revision, shared.read, tempRoot, transfer.signal, transfer.progress) }
        finally { shared.close() }
      })
    } finally { if (!held) owner.close() }
  }
}
