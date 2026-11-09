import type { SessionpageOpenedFileChunk, SessionpageOpenedFileReadRequest } from '@gugu/session-core/session-record/contract'
import { sessionWorkspace, WORKSPACE_APP_ID, type WorkspaceFileRef } from '../../session/shared/extensions/app-runtime-protocol'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { callOnComputer } from './phoneProgramCall'

export type ReadWorkingCopyChunk = (offset: number, length: number) => Promise<SessionpageOpenedFileChunk>

/** A phone's file preview reads the working copy through the same machine call as its folder listing. */
export async function openPhoneWorkingCopyFile(
  app: Parameters<typeof callOnComputer>[0],
  session: Parameters<typeof callOnComputer>[1],
  ref: WorkspaceFileRef,
  show: (path: string, read: ReadWorkingCopyChunk) => void,
): Promise<void> {
  const read: ReadWorkingCopyChunk = async (offset, length) =>
    await callOnComputer(app, session, 'filesRead', { ref, offset, length }) as SessionpageOpenedFileChunk
  // Validate on the owning machine before acknowledging the open. No output-ledger grant is invented for a click.
  await read(0, 1)
  show('id' in ref ? ref.id : ref.name, read)
}

/**
 * A file a session's timeline names — a link in a reply, a file it edited: read from that session's working copy on its
 * machine, the same call the Files App's preview makes (above), not the ledger of files the session opened itself. A path
 * is the working copy's; an absolute one is refused there unless the host handed it over.
 */
export function sessionWorkingCopyReader(session: { id: string; deviceId: string }): (request: SessionpageOpenedFileReadRequest) => Promise<SessionpageOpenedFileChunk> {
  return async ({ path, offset, length }) => {
    const manifest = installedExtensionsStore.manifestFor(WORKSPACE_APP_ID)
    if (!manifest) throw Object.assign(new Error('The Files App is not installed'), { code: 'not-installed' })
    const ref = { workspace: sessionWorkspace(session.id), name: path }
    return await callOnComputer({ extensionId: manifest.id, extensionName: manifest.name, version: manifest.version }, { ...session, deviceLabel: null }, 'filesRead', { ref, offset, length }) as SessionpageOpenedFileChunk
  }
}
