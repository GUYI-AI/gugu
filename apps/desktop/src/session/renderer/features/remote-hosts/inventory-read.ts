import { HOST_WS_STALE_MS } from '@shared/lib/ipc/host-ws-protocol';
import { machineClient, machineLinkState, reconnectMachine } from '@renderer/lib/machine-clients';
import { log } from '@renderer/utils/logger';

/** A remote inventory read belongs to one open host window. A heartbeat acknowledges the pipe, not this read. */
export function watchInventoryRead(deviceId: string, waitingFor: 'projects' | 'sessions snapshot') {
  const client = machineClient(deviceId);
  if (client?.state() !== 'open' || machineLinkState(deviceId) !== 'open') return;

  let current = true;
  const off = client.onStateChange(() => {
    current = false;
    finish();
  });
  const timer = setTimeout(() => {
    finish();
    if (!current || machineLinkState(deviceId) !== 'open') return;
    current = false;
    log.warn('[machines] remote inventory read timed out', { deviceId, waitingFor });
    reconnectMachine(deviceId, { automatic: true });
  }, HOST_WS_STALE_MS);

  function finish() {
    clearTimeout(timer);
    off();
  }
  return { current: () => current, finish };
}
