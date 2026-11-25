import { registerPlugin } from '@capacitor/core'
import { mobileAccountClosureV2, type MobileAccountClosureV2Bridge } from './mobileAccountClosureV2'
import { phoneAccountClosureV2 } from './phoneAccountClosureV2'

export const nativeAndroidAccountClosureV2 = phoneAccountClosureV2(
  mobileAccountClosureV2(registerPlugin<MobileAccountClosureV2Bridge>('GuguAccountClosureV2')),
  async ownerId => {
    const { quiescePhoneForAccountClosure } = await import('../mobile/phone-device/phoneDeviceRuntime')
    await quiescePhoneForAccountClosure(ownerId)
  },
)
