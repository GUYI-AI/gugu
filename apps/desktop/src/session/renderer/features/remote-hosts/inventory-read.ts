import type { SessionHostClient } from '@shared/lib/ipc/session-host-client';
import { machineClient, machineLinkState, reconnectMachine } from '@renderer/lib/machine-clients';
import { log } from '@renderer/utils/logger';

export const INVENTORY_READ_TIMEOUT_MS = 40_000;
const MAX_INVENTORY_READ_TIMEOUT_MS = 160_000;

type Inventory = 'projects' | 'sessions snapshot';
type InventoryProgress = {
  timeoutMs: number;
  pending: Map<() => void, Inventory>;
  missing: Set<Inventory>;
};

// The client survives reconnects, but is replaced when a device is forgotten or the account changes.
const progressByClient = new WeakMap<SessionHostClient, InventoryProgress>();

export function watchInventoryRead(deviceId: string, waitingFor: Inventory) {
  const client = machineClient(deviceId);
  if (client?.state() !== 'open' || machineLinkState(deviceId) !== 'open') return;

  let progress = progressByClient.get(client);
  if (!progress) {
    progress = { timeoutMs: INVENTORY_READ_TIMEOUT_MS, pending: new Map(), missing: new Set() };
    progressByClient.set(client, progress);
  }
  const state = progress;
  const timeoutMs = state.timeoutMs;
  let current = true;
  const off = client.onStateChange(cancel);
  const timer = setTimeout(() => {
    if (machineLinkState(deviceId) !== 'open') {
      cancel();
      return;
    }
    // Reopening cancels all pending reads. A successful sibling cannot clear their backoff.
    for (const inventory of state.pending.values()) state.missing.add(inventory);
    state.timeoutMs = Math.min(timeoutMs * 2, MAX_INVENTORY_READ_TIMEOUT_MS);
    cancel();
    log.warn('[machines] remote inventory read timed out', { deviceId, waitingFor, timeoutMs });
    reconnectMachine(deviceId, { automatic: true });
  }, timeoutMs);
  state.pending.set(cancel, waitingFor);

  function cancel() {
    if (!current) return;
    current = false;
    clearTimeout(timer);
    off();
    state.pending.delete(cancel);
  }

  function received() {
    if (!current) return;
    if (state.missing.delete(waitingFor) && !state.missing.size) state.timeoutMs = INVENTORY_READ_TIMEOUT_MS;
    cancel();
  }
  return { current: () => current, received, cancel };
}
