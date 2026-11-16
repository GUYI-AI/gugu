import { replica } from '../lib/replica'
import { platform } from '../platform'

/** Which of the account's machines this computer is, as the local host knows it (IPC, ❌ the cloud list). null = not yet. */
export const thisDeviceId = replica({
  name: 'thisDeviceId',
  scope: 'account',
  networkMode: 'always',
  fresh: Infinity,
  read: async () => (await platform.getLocalDeviceSelfSnapshot?.())?.device_id ?? null,
  watch: { start: () => platform.subscribeLocalDeviceIdentified?.(() => { void thisDeviceId.refresh() }) ?? (() => undefined) },
})
