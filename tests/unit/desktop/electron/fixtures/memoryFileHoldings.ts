import type { FileRef, FileRevision } from '../../../../../packages/core/src/shared/fileResolver'
import { setFileHoldings, type FileHoldings } from '../../../../../apps/desktop/electron/fileHoldings'

/**
 * The host side of file holdings for tests of the modules that use them (publication, reading, transfer): folders bound
 * to chats and the versions published from them, kept in memory. What is held is decided by the session backend's
 * core/folders/file-revisions.ts, tested over a real database there; this only answers with what the test put in.
 */
export function installMemoryFileHoldings(folders: Record<string, { root: string; chatId: string | null }>) {
  const files = new Map<string, FileRevision>()
  const bound = (revision: FileRevision) => revision.host_project_id === 'device-store'
    || (!!revision.host_project_id && folders[revision.host_project_id]?.chatId === revision.chat_id)
  const held = (revision: FileRevision | null | undefined, ownerId: string, deviceId: string) =>
    revision && revision.source === 'local' && revision.host_account_id === ownerId && revision.host_device_id === deviceId && bound(revision)
      ? revision : null
  const holdings: FileHoldings = {
    async read(ref: FileRef, ownerId, deviceId, lookup) {
      if (!('item_id' in ref)) return null
      const mine = files.get(`${ownerId}/${ref.item_id}`)
      const answer = ref.version !== undefined && mine?.version === ref.version ? mine : await lookup(ref)
      if (!answer || answer.item_id !== ref.item_id || (ref.version !== undefined && answer.version !== ref.version)) return null
      return held(mine && mine.version === answer.version ? mine : answer, ownerId, deviceId)
    },
    remember(revision, ownerId) {
      if (revision.host_account_id !== ownerId || !revision.chat_id) throw new Error('File owner or group mismatch')
      if (!bound(revision)) throw new Error('Folder binding changed')
      files.set(`${ownerId}/${revision.item_id}`, revision)
    },
    findCopy: (key, sha, ownerId, deviceId) => held([...files.values()].findLast((row) => row.host_project_id === key && row.sha256 === sha
      && row.relative_path?.startsWith('.gugu/attachments/')), ownerId, deviceId),
    findByName: (chat, name, ownerId, deviceId) => held([...files.values()].find((row) => row.chat_id === chat && row.workspace?.path === name), ownerId, deviceId),
    root: (key) => folders[key]?.root ?? null,
    firstFolder: (chatId) => Object.entries(folders).find(([, folder]) => folder.chatId === chatId)?.[0],
  }
  setFileHoldings(holdings)
  return { folders, files }
}
