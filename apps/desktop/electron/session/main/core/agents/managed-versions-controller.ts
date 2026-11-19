import type { DependencyId } from '@gugu/session-core/deps/runtime';
import { getDependencyManager } from '../dependencies/dependency-managers';
import { hostDependencyStore } from '../dependencies/host-dependency-store';
import { cleanupManagedAgentVersions, readManagedAgentVersions } from '../dependencies/managed-agent-versions';

async function targetFor(id: DependencyId) {
  const manager = await getDependencyManager();
  const selected = await hostDependencyStore.getSelection('local', id);
  const options = manager.getInstallOptions(id);
  const target = options.find(option => option.target?.kind === 'mise' && (!selected?.registry || option.registry === selected.registry))?.target;
  if (target?.kind !== 'mise') throw new Error('This program has no managed mise installation');
  return target;
}

export const managedVersionActions = {
  getManagedVersions: async (id: DependencyId) => readManagedAgentVersions(await targetFor(id)),
  cleanupManagedVersions: async (id: DependencyId, versions: string[]) => cleanupManagedAgentVersions(await targetFor(id), versions),
};
