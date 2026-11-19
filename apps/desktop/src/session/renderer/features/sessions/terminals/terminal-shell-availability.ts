import { replica } from '@/lib/replica';
import { rpc } from '@renderer/lib/ipc';

/** The shells this device can start, with why one cannot. */
export const shellAvailability = replica({
  name: 'terminalShellAvailability',
  scope: 'device',
  read: () => rpc.terminals.getTerminalShellAvailability(),
  fresh: 30_000,
  persist: { maxBytes: 1024, maxEntries: 1 },
});
