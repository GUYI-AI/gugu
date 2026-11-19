import { syncRootDirectory } from '../password-vault/sync'
import { removeClosureOwnerDirectory } from './owner-directory'

/** Both account roots contain private material. The sync root is the same one
 * used by VaultSync, including its device key and interrupted atomic writes. */
export async function eraseClosedAccountPasswordData(root: string, ownerId: string): Promise<void> {
  await removeClosureOwnerDirectory(root, ownerId)
  await removeClosureOwnerDirectory(syncRootDirectory(root), ownerId)
}
