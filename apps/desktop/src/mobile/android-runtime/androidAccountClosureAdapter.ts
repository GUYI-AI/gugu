import { getRendererSession } from '@/lib/sessionPublication'
import { nativeAndroidAccountClosure, nativeAndroidClosurePreparation } from '@/platform/androidAccountClosure'
import type { AccountClosureRequestActions } from '@/components/settings/accountDeletion/accountClosureComposition'
import { createAccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureJournal'
import type { AccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureLocalCleanup'
import { quiescePhoneForAccountClosure, withdrawPhoneForAccountClosure } from '../phone-device/phoneDeviceRuntime'
import { composeAndroidAccountClosure } from './androidAccountClosureComposition'

/** Unwired Android injection entry; no Settings entry and no closure endpoint. */
export async function createAndroidAccountClosureFlow(input: {
  ownerId: string
  requests: AccountClosureRequestActions
  journal?: AccountClosureJournal
}) {
  let journal: AccountClosureJournal
  try { journal = input.journal ?? createAccountClosureJournal(globalThis.localStorage) }
  catch { throw Object.assign(new Error('Account closure metadata is unavailable'), { code: 'closure_storage_unavailable' }) }
  return composeAndroidAccountClosure({ ...input, journal }, {
    native: nativeAndroidAccountClosure, preparation: nativeAndroidClosurePreparation,
    currentOwnerId: () => getRendererSession()?.user.id ?? null,
    stopPublication: quiescePhoneForAccountClosure, removeRegistration: withdrawPhoneForAccountClosure,
  })
}
