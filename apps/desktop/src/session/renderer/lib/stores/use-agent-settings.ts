import { useMutation } from '@tanstack/react-query';
import { useReplica } from '@/lib/replica';
import { agentSettings } from './agent-replicas';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

/**
 * Manages settings for a single agent on the library's machine (#6264: 附加参数与环境变量是那台机器上这家的设置):
 * the `agentSettings` reading, mutations for update and reset-to-defaults.
 */
export function useAgentSettings(id: string) {
  const host = useLibraryHost();
  const agentsRpc = host.agents;
  const machine = host.remote?.deviceId ?? null;
  const reading = useReplica(agentSettings, [machine, id], { read: host.remote?.online !== false });

  const updateMutation = useMutation<void, Error, Partial<ProviderCustomConfig>>({
    mutationFn: (config) => agentsRpc.updateSettings(id, config),
    onSuccess: () => { void agentSettings.refresh(machine, id); },
  });

  const resetMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      const defaults = await agentsRpc.getDefaultSettings(id);
      if (defaults) {
        await agentsRpc.updateSettings(id, defaults);
      }
    },
    onSuccess: () => { void agentSettings.refresh(machine, id); },
  });

  const data = reading.state === 'value' ? reading.value : null;
  return {
    isLoading: reading.state === 'unknown',
    value: data?.value,
    defaults: data?.defaults,
    overrides: data?.overrides,
    isSaving: updateMutation.isPending || resetMutation.isPending,
    isOverridden: !!(data?.overrides && Object.keys(data.overrides).length > 0),
    isFieldOverridden: (field: keyof ProviderCustomConfig) =>
      !!(data?.overrides && field in data.overrides),
    update: updateMutation.mutate,
    updateAsync: updateMutation.mutateAsync,
    reset: resetMutation.mutate,
  };
}
