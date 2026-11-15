import { useMutation } from '@tanstack/react-query';
import { queryClient, useReadModel, type Reading } from '@/lib/readModel';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import {
  appSettingsModel,
  getAppSettingValueSnapshot,
  invalidateAppSettingsKey,
  mergeAppSettingsValue,
  setAppSettingsValueInCache,
  updateAppSettingsRequest,
  LOCAL_SETTINGS_HOST_KEY,
  type SettingsMeta,
} from './app-settings-client';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { useSettingsHost } from './settings-host';

export { getAppSettingValueSnapshot };

export type AppSettingsKeyApi<K extends AppSettingsKey> = ReturnType<typeof useAppSettingsKey<K>>;

/**
 * One settings key as the read model has it. `settings` is unknown only before this device ever read it (startup reads
 * the whole set once); a surface draws `<Unknown/>` then — never the schema default dressed as the stored value.
 */
export function useAppSettingsKey<K extends AppSettingsKey>(key: K) {
  // #6264 跟机器走的那几组(默认 tmux、仓库)在「选了别的机器」时读写那台机器;读模型里另起一份(主机参数),
  // ❌ 动本机那一份(整个窗口都在读)。那台机器离线就不问(问不到,只会挂满超时)。
  const host = useSettingsHost();
  const remote = host.remote;
  const settings = useReadModel(appSettingsModel, !remote || remote.online ? [key, host.key] : null) as Reading<SettingsMeta<K>>;
  const current = settings.state === 'value' ? settings.value : undefined;
  const api = (host.key === LOCAL_SETTINGS_HOST_KEY ? rpc : rpcOn(host.key)).appSettings;

  const updateMutation = useMutation<void, Error, Partial<AppSettings[K]>, { prev: AppSettings[K] }>({
    mutationFn: (partial) => {
      const reading = appSettingsModel.peek(key, host.key);
      if (reading.state !== 'value') throw new Error(`settings ${key}: not read yet`);
      return updateAppSettingsRequest(key, mergeAppSettingsValue<K>((reading.value as SettingsMeta<K>).value, partial), host.key);
    },
    onMutate: (partial) => {
      const reading = appSettingsModel.peek(key, host.key);
      if (reading.state !== 'value') throw new Error(`settings ${key}: not read yet`);
      const prev = (reading.value as SettingsMeta<K>).value;
      setAppSettingsValueInCache(key, mergeAppSettingsValue<K>(prev, partial), host.key);
      return { prev };
    },
    onError: (_err, _partial, ctx) => {
      if (ctx) setAppSettingsValueInCache(key, ctx.prev, host.key);
    },
    onSettled: () => invalidateAppSettingsKey(key, host.key),
  }, queryClient);

  const resetMutation = useMutation<void, Error, void>({
    mutationFn: () => api.reset(key) as Promise<void>,
    onSuccess: () => invalidateAppSettingsKey(key, host.key),
  }, queryClient);

  const resetFieldMutation = useMutation<void, Error, keyof AppSettings[K]>({
    mutationFn: (field) => api.resetField(key, field as string) as Promise<void>,
    onSuccess: () => invalidateAppSettingsKey(key, host.key),
  }, queryClient);

  return {
    settings,
    /** Another machine cannot act now: offline, or its read failed (server too old / unreachable). Rows stay, controls grey. */
    unavailable: !!remote && (!remote.online || settings.state === 'error'),
    isSaving: updateMutation.isPending || resetMutation.isPending || resetFieldMutation.isPending,
    isOverridden: !!current && Object.keys(current.overrides).length > 0,
    isFieldOverridden: (field: keyof AppSettings[K]) => !!current && field in current.overrides,
    update: updateMutation.mutate,
    updateAsync: updateMutation.mutateAsync,
    reset: resetMutation.mutate,
    resetField: (field: keyof AppSettings[K]) => resetFieldMutation.mutate(field),
  };
}
