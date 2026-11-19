/**
 * A device capability group (screen, clipboard, perf …) an agent's `device_call` needs and this computer has not connected:
 * asked of the person as an approval in that agent's session (Ask source `device-capability`), answered from any surface that
 * follows it — the session page, the chat's band, the phone, the notification list. 「允许」 connects the group exactly as
 * Settings → Devices does; the settings page stays where it is turned off again.
 */
export interface DeviceCapabilityAsk {
  group: string;
  /** The group's name as the devices settings page shows it, by locale (`zh-CN`, `en-US`). */
  groupTitle: Readonly<Record<string, string>>;
  /** The action that was called. */
  action: string;
  requester: { name: string; agentUserId: string | null };
}
export const DEVICE_CAPABILITY_ALLOW = 'allow';
export const DEVICE_CAPABILITY_DECLINE = 'decline';

/** The capability a session's approval asks about, when it is one (read on every surface from `Settlement.origin`). */
export function deviceCapabilityAskOf(origin: { source: string; payload?: unknown } | undefined): DeviceCapabilityAsk | null {
  if (origin?.source !== 'device-capability') return null;
  const payload = origin.payload as Partial<DeviceCapabilityAsk> | null;
  return payload && typeof payload.group === 'string' && payload.groupTitle && payload.requester ? (payload as DeviceCapabilityAsk) : null;
}
