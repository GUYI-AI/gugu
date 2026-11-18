import type { LiveSettingCapability } from '@gugu/session-core/agents/plugins';

/** An advertised catalog is not evidence of a live mutation channel. */
export function liveSettingOptions<T>(
  options: T | null,
  setting: Pick<LiveSettingCapability, 'channel'> | null | undefined,
): T | null {
  return setting?.channel === 'unsupported' ? null : options;
}
