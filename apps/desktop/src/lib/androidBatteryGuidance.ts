import { nativePhoneActions } from '../mobile/phone-device/nativePhoneActions'
import { platform } from '../platform'
import { replica } from './replica'

// Native facts belong to the device replica, not an effect copying its answer into component state.
// No persisted snapshot: eligibility is read again when the settings surface opens.
export const androidBatteryGuidance = replica({
  name: 'androidBatteryGuidance',
  scope: 'device',
  keep: 0,
  read: async () => {
    const permission = await platform.checkSystemPermission('batteryOptimization')
    const device = permission === 'prompt' ? await nativePhoneActions.deviceInfo().catch(() => null) : null
    const onePlus = [device?.brand, device?.manufacturer].some(name => name?.toLowerCase() === 'oneplus')
    return { permission, onePlus }
  },
})
