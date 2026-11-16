import { fileMetadata as readFileMetadata } from './fileAccess'
import { replica } from './replica'

/**
 * A chat file's metadata as the resolver answers this reader (name, state, the machine that keeps this version). Shared
 * by the file link pill and `useFileHost`. No push: read when shown, kept five minutes after nothing shows it. Flows that
 * must ask afresh (why a read failed, whether a machine is back: lib/fileHost.ts) call the resolver directly on purpose.
 */
export const chatFileMetadata = replica({
  name: 'fileMetadata',
  scope: 'account',
  keep: 5 * 60_000,
  read: (_accountId: string, itemId: string, version: number | null) => readFileMetadata(itemId, version ?? undefined),
})
