import { lstat, rm } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

/** Only a native, fixed root plus a validated account id. Refuse aliases rather
 * than following a symlink into another account's or a person's workspace. */
export async function removeClosureOwnerDirectory(root: string, ownerId: string): Promise<void> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ownerId)) throw new Error('Invalid cleanup owner')
  const target = join(resolve(root), ownerId)
  const ancestors: string[] = []
  for (let path = target; path !== parse(path).root; path = dirname(path)) ancestors.unshift(path)
  for (const path of ancestors) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Account cleanup directory is an alias') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  await rm(target, { recursive: true, force: true })
}
