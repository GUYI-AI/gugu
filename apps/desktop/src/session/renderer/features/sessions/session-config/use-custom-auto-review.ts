import { useReplica } from '@/lib/replica';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { autoReviewModelSchema } from '@gugu/session-core/models/auto-review-model';
import { customClaudeReviewSource } from '@gugu/session-core/models/auto-review-source';
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY } from '@renderer/features/settings/app-settings-client';

/** Creation reads the executor's preference. Running sessions use their host-owned config facts. */
export function useCustomAutoReview(connection: CustomModelConnection | undefined, modelId: string | undefined, machine: string | null) {
  const endpoint = connection?.endpoints.find(item => item.protocol === 'anthropic-messages');
  const settings = useReplica(appSettingsModel, connection?.keySaved && endpoint ? ['autoReviewModel', machine ?? LOCAL_SETTINGS_HOST_KEY] : null);
  if (!connection || !endpoint || settings.state !== 'value') return null;
  const parsed = autoReviewModelSchema.safeParse(settings.value.value);
  return customClaudeReviewSource({ connectionId: connection.id, endpoint: endpoint.baseUrl,
    selectedModel: modelId, models: connection.models, removed: connection.removed,
    preference: parsed.success ? parsed.data : null });
}
