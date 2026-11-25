import { eq } from 'drizzle-orm';
import { contextThresholdKey, supportsContextThreshold } from '@gugu/session-core/models/context-threshold';
import { platformOptionId } from '@/session/shared/platform-model-id';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { sessionPlatformModel } from '@main/core/sessions/platform-model-selection';
import { appSettingsService } from '@main/core/settings/settings-service';

export async function sessionContextThreshold(id: string) {
  const { config, provider } = db.select({
    config: sessions.config, provider: sessions.provider,
  }).from(sessions).where(eq(sessions.id, id)).get() ?? {};
  if (!provider || !supportsContextThreshold(provider)) return undefined;
  const platform = (await sessionPlatformModel(id))?.modelId;
  const model = platform ? platformOptionId(platform) : config?.model;
  if (!model) return undefined;
  const thresholds = await appSettingsService.get('contextThresholds');
  return thresholds[contextThresholdKey(provider, model)];
}
