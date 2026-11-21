import { retireNativeImMessageAccount } from './im-messages/controller'
import { createClosureOperationRecords } from '../../../account-closure/operation-record'
import { createDesktopClosureV2Service } from '../../../account-closure/v2-service'
import { createClosureV2Http, type ClosureV2Auth } from '../../../account-closure/v2-http'
import type { createDesktopClosureService } from '../../../account-closure/service'
import { encryptedAppSecretsStore } from './secrets/encrypted-app-secrets-store'
/** Same protected store and native identity barrier as the existing local host. */
export function createDesktopAccountClosureV2Host(input: {
  profileBinding: string
  local: ReturnType<typeof createDesktopClosureService>
  auth(): Promise<ClosureV2Auth | null | undefined>
  deviceId(): Promise<string>
  resumeOwner(ownerId: string): Promise<void>
  baseUrl: string
  anonKey: string
}) {
  const records = createClosureOperationRecords({
    secrets: encryptedAppSecretsStore, profileBinding: input.profileBinding, underAuth: input.local.underAuth,
    identity: async () => { const a = await input.auth(); return a && { ownerId: a.ownerId, sessionId: a.sessionId } },
  })
  return createDesktopClosureV2Service({ records, local: input.local, auth: input.auth, deviceId: input.deviceId, resumeOwner: input.resumeOwner, retireMessages: retireNativeImMessageAccount,
    http: createClosureV2Http({ baseUrl: input.baseUrl, anonKey: input.anonKey }) })
}
