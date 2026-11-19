import { registerPlugin } from '@capacitor/core'
import { mobileAccountClosureV2, type MobileAccountClosureV2Bridge } from './mobileAccountClosureV2'
import { phoneAccountClosureV2 } from './phoneAccountClosureV2'

const retainedNames = ['auth-main-unattributed', 'auth-code-verifier', 'auth-oauth-pending', 'files-staging',
  'retirement-unattributed', 'push-deduplication'] as const

export const nativeIOSAccountClosureV2 = phoneAccountClosureV2(
  mobileAccountClosureV2(registerPlugin<MobileAccountClosureV2Bridge>('GuguAccountClosureV2'), retainedNames),
  async ownerId => {
    const { quiescePhoneForAccountClosure } = await import('../mobile/phone-device/phoneDeviceRuntime')
    await quiescePhoneForAccountClosure(ownerId)
  },
)
