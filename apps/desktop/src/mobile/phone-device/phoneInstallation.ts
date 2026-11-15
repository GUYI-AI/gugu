import { replica, replicaAccount } from '@/lib/replica'
import { nativePhoneActions } from './nativePhoneActions'
import { cachedPhoneInstallation, phoneInstallId } from './phoneDeviceSettings'

export async function readPhoneInstallation(ownerId: string) {
  return nativePhoneActions.deviceInfo({ ownerId, ...cachedPhoneInstallation() })
}

/**
 * This phone's native installation as the signed-in account's device (its device info and installation id). Read once
 * per account and run: the installation does not change while the app runs. The read checks the binding (a restored
 * backup of another installation clears the consent choices, `phoneInstallId`) — in this one place, for the setup gate
 * and the device runtime alike.
 */
export const phoneInstallation = replica({
  name: 'phoneInstallation',
  scope: 'account',
  read: async (owner: string) => {
    const info = await readPhoneInstallation(owner)
    return { info, installId: phoneInstallId(info.install_key ?? '', info.registration_id ?? '', info.previous_install_key) }
  },
  fresh: Infinity,
})

/** For code outside React (the device runtime): the installation of `ownerId`, through the replica when it is the account. */
export async function readPhoneInstallationOf(ownerId: string) {
  if (replicaAccount().id === ownerId) return phoneInstallation.fetch()
  const info = await readPhoneInstallation(ownerId)
  return { info, installId: phoneInstallId(info.install_key ?? '', info.registration_id ?? '', info.previous_install_key) }
}
