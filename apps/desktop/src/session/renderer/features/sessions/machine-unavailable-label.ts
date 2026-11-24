import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { hostStatusLabel } from '@renderer/features/remote-hosts/connection-status';
import { machineLinkState } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { workspaceReachLabel } from './workspace-backend/workspace-surface';

/**
 * Preparation screens and action notifications name the same unavailable machine, while its line is not open, with the
 * sidebar dot's own sentence for its state (connecting, reconnecting, offline, sign-in, too old: `hostStatusLabel`).
 * A machine the list does not have is offline.
 */
export function machineUnavailableLabel(projectId: string): string | null {
  const reason = workspaceReachLabel(projectId);
  if (reason) return reason;
  const machine = machineRegistry.machineOf(projectId);
  if (!machine || machineLinkState(machine) === 'open') return null;
  const device = remoteHostsStore.device(machine);
  return hostStatusLabel(remoteHostsStore.connectionState(machine) ?? 'offline', device?.label ?? machine, device?.lastSeenAt,
    Date.now(), translateSessionMessage, device?.signInExpiredAt);
}
