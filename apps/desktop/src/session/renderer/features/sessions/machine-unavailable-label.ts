import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { hostStatusLabel } from '@renderer/features/remote-hosts/connection-status';
import { machineLinkState } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { workspaceReachLabel } from './workspace-backend/workspace-surface';
import type { SessionPageStore } from './stores/session-store';

/**
 * Preparation screens and action notifications name the same unavailable machine, while its line is not open, with the
 * sidebar dot's own sentence for its state (connecting, reconnecting, offline, sign-in, too old: `hostStatusLabel`).
 * A machine the list does not have is offline.
 */
export function machineUnavailableLabel(projectId: string): string | null {
  const reason = workspaceReachLabel(projectId);
  if (reason) return reason;
  const machine = machineRegistry.machineOf(projectId);
  if (!machine) return null;
  // Read before the link: the store mirrors the link in an observable, so reactions re-run when it opens or drops.
  const state = remoteHostsStore.connectionState(machine);
  if (machineLinkState(machine) === 'open') return null;
  const device = remoteHostsStore.device(machine);
  return hostStatusLabel(state ?? 'offline', device?.label ?? machine, device?.lastSeenAt,
    Date.now(), translateSessionMessage, device?.signInExpiredAt);
}

/**
 * A session listed here whose machine does not answer opens as its usual page, with no workspace until that machine is
 * back (owner 11-24: one page, the machine's state in its strip). Its conversation reads the record without one; the
 * workspace's own tabs wait (PaneContent `conversationsOnly`). A project that never mounted has no session to draw.
 */
export function drawnWithoutWorkspace(store: SessionPageStore | undefined): boolean {
  return store?.state === 'unprovisioned' && !store.data.archivedAt && machineUnavailableLabel(store.data.projectId) !== null;
}
