import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { replica } from '@/lib/replica';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';

/** Read from the machine running the task; never persist credential availability across devices. */
export const customModels = replica({
  name: 'customModels', scope: 'device', fresh: 30_000,
  read: async (_device: string, machine: string | null): Promise<CustomModelConnection[]> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).listCustomModels();
    if (!result.success) throw new Error(errorText(result.error));
    return result.data;
  },
});
