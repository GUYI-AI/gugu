import { setBrowserCorsRelaxationSettings } from '@main/core/browser/browser-profile-session';
import { browserWebContentsRegistry } from '@main/core/browser/browser-webcontents-registry';
import { reconcileResourceSampler } from '@main/core/resource-monitor/resource-sampler';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { AppSettingsKeys, appSettingsService, type AppSettings, type AppSettingsKey } from './settings-service';

async function reconcileSettingsRuntimeState(key: AppSettingsKey): Promise<void> {
  if (key === 'resourceMonitor') await reconcileResourceSampler();
  if (key === 'keyboard') {
    // Re-read the effective settings so runtime state observes service-side defaults or merges.
    browserWebContentsRegistry.setKeyboardSettings(await appSettingsService.get('keyboard'));
  }
  if (key === 'browser') {
    setBrowserCorsRelaxationSettings(await appSettingsService.get('browser'));
  }
}

export const appSettingsController = createRPCController({
  get: <T extends AppSettingsKey>(key: T): Promise<AppSettings[T]> => appSettingsService.get(key),

  /** Every key with its defaults and overrides: the renderer's startup read (one call instead of one per key). */
  getAll: async (): Promise<{ [K in AppSettingsKey]: Awaited<ReturnType<typeof appSettingsService.getWithMeta<K>>> }> =>
    Object.fromEntries(
      await Promise.all(AppSettingsKeys.map(async (key) => [key, await appSettingsService.getWithMeta(key)] as const))
    ) as never,

  getWithMeta: <T extends AppSettingsKey>(
    key: T
  ): Promise<{
    value: AppSettings[T];
    defaults: AppSettings[T];
    overrides: Partial<AppSettings[T]>;
  }> => appSettingsService.getWithMeta(key),

  update: async <T extends AppSettingsKey>(key: T, value: AppSettings[T]): Promise<void> => {
    await appSettingsService.update(key, value);
    await reconcileSettingsRuntimeState(key);
  },

  reset: async <T extends AppSettingsKey>(key: T): Promise<void> => {
    await appSettingsService.reset(key);
    await reconcileSettingsRuntimeState(key);
  },

  resetField: async <T extends AppSettingsKey>(key: T, field: string): Promise<void> => {
    await appSettingsService.resetField(key, field as keyof AppSettings[T]);
    await reconcileSettingsRuntimeState(key);
  },
});
