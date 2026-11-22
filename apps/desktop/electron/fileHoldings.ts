// @@@group-folders — which file versions this device holds, and where its holder keys point. Implemented by the session
// backend over its database (core/folders/file-revisions.ts); main.ts installs it when that module loads. Calls before
// that fail loudly (❌ answering "not held").
import type { FileRef, FileRevision } from '@gugu/core/shared/fileResolver'

export type FileVersionLookup = (ref: { item_id: string; version?: number }) => Promise<FileRevision | null>

export type FileHoldings = {
  read(ref: FileRef, ownerId: string, deviceId: string, lookup: FileVersionLookup): Promise<FileRevision | null>
  remember(revision: FileRevision, ownerId: string): void
  findCopy(key: string, sha: string, ownerId: string, deviceId: string): FileRevision | null
  findByName(chat: string, name: string, ownerId: string, deviceId: string): FileRevision | null
  /** A version of this sha the device holds for the account, from its version records (no database lookup). */
  heldBySha(sha256: string, ownerId: string, deviceId: string): FileRevision | null
  /** The directory a holder key's relative paths are relative to (a folder, or a released project's root); null = none. */
  root(key: string): string | null
  /** The first folder this device binds to a chat (where what it sends there is kept). */
  firstFolder(chatId: string): string | undefined
}

let installed: FileHoldings | null = null

export function setFileHoldings(holdings: FileHoldings | null): void { installed = holdings }

export function fileHoldings(): FileHoldings {
  if (!installed) throw new Error('File holdings are not available yet')
  return installed
}
