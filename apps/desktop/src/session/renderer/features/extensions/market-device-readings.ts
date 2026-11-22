import { replica } from '@/lib/replica';

/**
 * What a market item is on another of the person's devices (installed, which version, can it go there), read when a
 * picker of devices is open. One model for the desktop's picker and the phone's install sheet: each registers how it
 * reads an item (`readKey`) on a device id, and the arguments stay data.
 */
const readers = new Map<string, (deviceId: string) => Promise<unknown>>();

/** The latest way to read `readKey` on a device (a surface registers it as it renders). */
export function readOnDevicesWith(readKey: string, read: (deviceId: string) => Promise<unknown>): void {
  readers.set(readKey, read);
}

export const marketDeviceReading = replica({
  name: 'marketDeviceReading',
  // Keyed by the device asked (each device belongs to one account); read whoever the session says, as the device list.
  scope: 'device',
  read: async (_owner: string, readKey: string, deviceId: string): Promise<unknown> => {
    const read = readers.get(readKey);
    if (!read) throw new Error(`No ${readKey} reading for device ${deviceId}`);
    return read(deviceId);
  },
  fresh: 30_000,
});
