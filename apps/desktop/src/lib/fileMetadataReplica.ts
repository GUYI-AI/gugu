import { fileMetadata as readFileMetadata } from './fileAccess'
import { replica } from './replica'

/** A chat file's metadata as the resolver answers this reader; flows that must ask afresh (lib/fileHost.ts) call the resolver directly. */
export const chatFileMetadata = replica({
  name: 'fileMetadata',
  scope: 'account',
  keep: 5 * 60_000,
  read: (_accountId: string, itemId: string, version: number | null) => readFileMetadata(itemId, version ?? undefined),
})
