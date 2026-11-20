import { replica } from '@/lib/replica';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import type { ManagedAgentVersionCleanup, ManagedAgentVersions } from '@shared/core/agents/managed-versions';

// Same selected-device controller as LibraryHost; never redirect a failed remote read to this machine.
const api = (deviceId: string | null) => deviceId ? rpcOn(deviceId).agents : rpc.agents;
export const managedVersions = replica({
  name: 'managed-agent-versions', scope: 'account', retry: 0,
  read: (_owner, deviceId: string | null, agentId: string) => api(deviceId).getManagedVersions(agentId as never) as Promise<ManagedAgentVersions>,
});

export async function cleanManagedVersions(deviceId: string | null, agentId: string, versions: string[]): Promise<ManagedAgentVersionCleanup> {
  const target = managedVersions.at(deviceId, agentId);
  const result = await api(deviceId).cleanupManagedVersions(agentId as never, versions) as ManagedAgentVersionCleanup;
  target.set(result.snapshot);
  return result;
}
