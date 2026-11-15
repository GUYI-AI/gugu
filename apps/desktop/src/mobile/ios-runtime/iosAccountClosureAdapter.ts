import { getRendererSession } from '@/lib/sessionPublication'
import { nativeIOSAccountClosure } from '@/platform/iosAccountClosure'
import { composePhoneAccountClosure, type AccountClosureRequestActions } from '@/components/settings/accountDeletion/accountClosureComposition'
import { createAccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureJournal'
import type { AccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureLocalCleanup'
import { iosOwnerClient, prepareIOSSignOut } from './iosOwnerClient'

/** The shared controller owns ordering. Both existing native methods validate
 * their explicit acknowledgements before this adapter confirms the next step.
 * No Auth sign-out, Keychain write or generic cascading device deletion here.
 */
export async function createIOSAccountClosureFlow(input: {
  ownerId: string
  requests: AccountClosureRequestActions
  journal?: AccountClosureJournal
}) {
  let journal: AccountClosureJournal
  try { journal = input.journal ?? createAccountClosureJournal(globalThis.localStorage) }
  catch { throw Object.assign(new Error('closure_storage_unavailable'), { code: 'closure_storage_unavailable' }) }
  return composePhoneAccountClosure({
    platform: 'ios', ownerId: input.ownerId,
    currentOwnerId: () => getRendererSession()?.user.id ?? null,
    native: nativeIOSAccountClosure,
    journal,
    requests: input.requests,
    stopAgent: async () => { await prepareIOSSignOut(input.ownerId); return { confirmed: true } },
    removeDevice: async () => { await iosOwnerClient.retire(input.ownerId); return { confirmed: true } },
  })
}
