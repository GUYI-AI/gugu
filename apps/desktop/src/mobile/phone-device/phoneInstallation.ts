import { replica, replicaAccount } from '@/lib/replica'
import { nativePhoneActions } from './nativePhoneActions'
import { cachedPhoneInstallation, phoneInstallId } from './phoneDeviceSettings'

export async function readPhoneInstallation(ownerId: string) {
  return nativePhoneActions.deviceInfo({ ownerId, ...cachedPhoneInstallation() })
}

/** Device info and installation id; `phoneInstallId` checks the binding (a restored backup of another installation clears the consent choices). */
async function readInstallationWithId(owner: string) {
  const info = await readPhoneInstallation(owner)
  return { info, installId: phoneInstallId(info.install_key ?? '', info.registration_id ?? '', info.previous_install_key) }
}

/** This phone's installation as the signed-in account's device: read once per account and run (it does not change while the app runs). */
export const phoneInstallation = replica({
  name: 'phoneInstallation',
  scope: 'account',
  read: readInstallationWithId,
  fresh: Infinity,
})

/** For code outside React (the device runtime): the installation of `ownerId`, through the replica when it is the account. */
export async function readPhoneInstallationOf(ownerId: string) {
  return replicaAccount().id === ownerId ? phoneInstallation.fetch() : readInstallationWithId(ownerId)
}
