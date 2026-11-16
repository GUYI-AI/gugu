import { replica } from '../lib/replica'
import { platform } from '../platform'

/**
 * Which of the account's machines this computer is, as the local host knows it (an IPC read: ❌ waits for the network,
 * ❌ the cloud device list, which may be unread or unreadable offline). null = not identified among the account's
 * devices yet; the host announces the moment it is (`subscribeLocalDeviceIdentified`).
 */
export const thisDeviceId = replica({
  name: 'thisDeviceId',
  scope: 'account',
  networkMode: 'always',
  fresh: Infinity,
  read: async () => (await platform.getLocalDeviceSelfSnapshot?.())?.device_id ?? null,
  watch: { start: () => platform.subscribeLocalDeviceIdentified?.(() => { void thisDeviceId.refresh() }) ?? (() => undefined) },
})
