import { getLocaleSnapshot } from '@/i18n';
import { DEVICE_CAPABILITY_ALLOW, DEVICE_CAPABILITY_DECLINE, type DeviceCapabilityAsk } from '@shared/device-capability-ask';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import { computerNamed } from './extension-consent';

/**
 * How a surface's approval band words a device capability ask (`device-capability`): who wants which group of which
 * computer, and its two answers. Answering is the plain `respond` with the option — no sheet of its own: 「允许」 is the whole
 * consent, the same as 「连接」 in Settings → Devices. `machine`: the computer the session runs on, when it is not this one.
 */
export function deviceCapabilityWords(
  ask: DeviceCapabilityAsk,
  translate: (key: SessionMessageLookupKey, params?: Readonly<Record<string, string | number>>) => string,
  machine?: string
): { title: string; label: (optionId: string) => string | undefined } {
  const group = ask.groupTitle[getLocaleSnapshot().resolvedLocale] ?? ask.groupTitle['en-US'] ?? ask.group;
  return {
    title: translate('devices.capabilityAskBand', { agent: ask.requester.name, group, computer: computerNamed(translate, machine) }),
    label: (optionId) =>
      optionId === DEVICE_CAPABILITY_ALLOW
        ? translate('devices.capabilityAllow')
        : optionId === DEVICE_CAPABILITY_DECLINE
          ? translate('devices.capabilityDecline')
          : undefined,
  };
}
