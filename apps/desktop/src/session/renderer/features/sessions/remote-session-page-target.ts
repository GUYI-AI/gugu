import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import type { sessionViewKind } from './stores/session-selectors';
import { machineUnavailableLabel } from './machine-unavailable-label';

/**
 * A task on another machine whose workspace is not ready here yet opens on its own page at once: what has been read
 * (local copy, cloud history) and a composer that queues (owner 11-23: ❌ a separate 「加载中」 page while it prepares or
 * while that machine does not answer). The workspace panel takes over once it is ready (SessionContentGate). `label`:
 * why that machine cannot be reached right now, if known. A cloud computer has its own wake screen instead; a setup that
 * failed on a machine that answers has its error screen.
 */
export function remoteSessionPageTarget(projectId: string, kind: ReturnType<typeof sessionViewKind>) {
  const preparing = kind === 'project-mounting' || kind === 'provisioning' || kind === 'idle';
  const failed = kind === 'provision-error' || kind === 'project-error';
  if (!preparing && !failed) return null;
  const deviceId = machineRegistry.machineOf(projectId);
  if (!deviceId || remoteHostsStore.cloudScope(deviceId)) return null;
  const label = machineUnavailableLabel(projectId);
  // A setup that failed on a machine that answers keeps its error screen and Retry (fail loudly).
  return preparing || label ? { deviceId, label } : null;
}
