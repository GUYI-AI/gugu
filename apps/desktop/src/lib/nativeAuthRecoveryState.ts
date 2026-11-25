import { replica } from './replica'
import { mainAuthSessionStorage } from './supabase'

/** Device-local, memory-only observation. Native rechecks the revision under its Auth lock. */
export const nativeAuthRecoveryState = replica({
  name: 'native-auth-recovery-state-v1',
  scope: 'device',
  keep: 0,
  read: () => mainAuthSessionStorage.recoveryState(),
})
