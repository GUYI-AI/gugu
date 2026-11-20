import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppSettingValueSnapshot: vi.fn(),
  setAppSettingsValueInCache: vi.fn(),
  updateAppSettingsRequest: vi.fn((_key: string, _value: unknown) => Promise.resolve()),
  showModal: vi.fn(),
  platform: { kind: 'electron' },
  device: { confirmBeforeCancelAndSend: true },
}));

vi.mock('@renderer/features/settings/app-settings-client', () => ({
  getAppSettingValueSnapshot: mocks.getAppSettingValueSnapshot,
  setAppSettingsValueInCache: mocks.setAppSettingsValueInCache,
  updateAppSettingsRequest: mocks.updateAppSettingsRequest,
  invalidateAppSettingsKey: vi.fn(),
  beginAppSettingsWrite: () => () => {},
  writeAppSetting: (key: string, value: unknown) => mocks.updateAppSettingsRequest(key, value),
}));
vi.mock('@/platform', () => ({ platform: mocks.platform }));
vi.mock('@/lib/devicePreferences', () => ({
  readDevicePreferences: () => mocks.device,
  writeDevicePreferences: (patch: Partial<typeof mocks.device>) => Object.assign(mocks.device, patch),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: mocks.showModal }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string) => key,
}));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));

import { requestSendQueuedPromptNow } from './send-queued-prompt-now-flow';

type ModalArgs = {
  dontAskAgainLabel?: string;
  onSuccess: (r: { dontAskAgain: boolean; scopeChecked: boolean }) => void;
};
const lastModal = () => mocks.showModal.mock.calls.at(-1)?.[1] as ModalArgs;

describe('requestSendQueuedPromptNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.kind = 'electron';
    mocks.device.confirmBeforeCancelAndSend = true;
  });

  it('lets the phone remember approval and ask again when the device setting is reset', () => {
    mocks.platform.kind = 'capacitor';
    mocks.getAppSettingValueSnapshot.mockReturnValue(undefined);
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(lastModal().dontAskAgainLabel).toBe('chat.cancelAndSendAlwaysAllow');
    expect(send).not.toHaveBeenCalled();
    lastModal().onSuccess({ dontAskAgain: true, scopeChecked: false });
    expect(mocks.device.confirmBeforeCancelAndSend).toBe(false);
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(mocks.showModal).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(mocks.updateAppSettingsRequest).not.toHaveBeenCalled();
    mocks.device.confirmBeforeCancelAndSend = true;
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(mocks.showModal).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends straight away when no turn is running', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: true });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: false, send });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('asks first while a turn is running, and offers "don\'t ask again"', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: true });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(send).not.toHaveBeenCalled();
    expect(lastModal().dontAskAgainLabel).toBe('chat.cancelAndSendDontAskAgain');
    lastModal().onSuccess({ dontAskAgain: false, scopeChecked: false });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.updateAppSettingsRequest).not.toHaveBeenCalled();
  });

  it('ticking "don\'t ask again" turns the setting off and still sends', () => {
    const current = { confirmBeforeArchive: true, confirmBeforeCancelAndSend: true };
    mocks.getAppSettingValueSnapshot.mockReturnValue(current);
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    lastModal().onSuccess({ dontAskAgain: true, scopeChecked: false });
    expect(mocks.updateAppSettingsRequest).toHaveBeenCalledWith('interface', {
      ...current,
      confirmBeforeCancelAndSend: false,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips the dialog once the setting is off', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeCancelAndSend: false });
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(mocks.showModal).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  // 读不到偏好时按「问」走,且不摆一个勾了也写不进去的复选框。
  it('asks without the checkbox while settings are not loaded', () => {
    mocks.getAppSettingValueSnapshot.mockReturnValue(undefined);
    const send = vi.fn();
    requestSendQueuedPromptNow({ cancelsTurn: true, send });
    expect(send).not.toHaveBeenCalled();
    expect(lastModal().dontAskAgainLabel).toBeUndefined();
  });
});
