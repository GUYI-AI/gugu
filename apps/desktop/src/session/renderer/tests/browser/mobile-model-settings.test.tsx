import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ModelSection } from '@/components/settings/ModelSection';
import { AuxiliaryModelsGroup } from '@/components/settings/AuxiliaryModelsGroup';
import { capacitorPlatform } from '@/platform/capacitor';
import { iosPlatform } from '@/platform/ios';
import { platform } from '@/platform';
import { i18n } from '@/i18n';
import { setLocalePreference } from '@/i18n';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { messageForUser } from '@/lib/userFacingError';
import '@/i18n/registerSettingsCatalog';
import '@/components/settings/settings.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

const state = vi.hoisted(() => ({ os: 'android', config: vi.fn(), settings: vi.fn(), agents: vi.fn(), hidden: vi.fn() }));
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>();
  const { capacitorPlatform: android } = await import('@/platform/capacitor');
  const { iosPlatform: ios } = await import('@/platform/ios');
  return { ...actual, platform: { ...actual.platform,
    get kind() { return state.os === 'desktop' ? 'electron' : 'capacitor'; },
    get capabilities() { return state.os === 'android' ? android.capabilities : state.os === 'ios' ? ios.capabilities : actual.platform.capabilities; },
  } };
});
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: (...args: unknown[]) => state.config(...args) }));
vi.mock('@renderer/lib/stores/use-agents', async original => ({ ...await original<object>(), useAgents: () => { state.agents(); return { state: 'value', value: [] }; } }));
vi.mock('@renderer/lib/ipc', async original => ({ ...await original<object>(), rpc: { appSettings: { getWithMeta: (...args: unknown[]) => state.settings(...args) } } }));
vi.mock('@/lib/agentModelReplicas', async () => {
  const { replica } = await import('@/lib/replica');
  return { platformModels: replica({ name: 'mobile-model-settings-catalog', scope: 'account', read: async () => [
    { id: 'available', displayName: '可用平台模型', enabled: true, hidden: false, requiresMembership: false },
  ] }) };
});
vi.mock('@/lib/agentModelSelection', async original => ({ ...await original<object>(), setPlatformModelHidden: (...args: unknown[]) => state.hidden(...args) }));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  state.os = 'android';
  state.config.mockReset().mockImplementation(() => { throw new Error('[session] host bridge unavailable: missing preload'); });
  state.settings.mockReset().mockImplementation(() => { throw new Error('Unexpected desktop settings read'); });
  state.agents.mockClear(); state.hidden.mockReset().mockResolvedValue(undefined);
  setLocalePreference('zh-CN'); await i18n.changeLanguage('zh-CN');
  await page.viewport(390, 844);
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
});
afterEach(() => { harness?.cleanup(); });

it.each(['android', 'ios'])('%s keeps one desktop guidance line, never starts desktop reads, and can still toggle platform models', async os => {
  state.os = os;
  expect((os === 'android' ? capacitorPlatform : iosPlatform).capabilities.modelSettings).toBe(false);
  // addRequested also covers a stale/deep-linked add action; it must not open an unusable dialog.
  await renderWithAppProviders(harness, <><ModelSection addRequested /><AuxiliaryModelsGroup /></>, { auth: { id: `mobile-models-${os}`, nickname: '测试账号', avatarUrl: '' }, contacts: {} });
  await expect.element(page.getByTestId('settings-models-desktop-only')).toHaveTextContent('Coding Plan、API Key 和自定义模型目前只能在电脑上设置。');
  expect(document.querySelectorAll('[data-testid="settings-models-desktop-only"]')).toHaveLength(1);
  expect(document.querySelector('[data-testid="settings-coding-plans"], [data-testid="settings-api-models"], [data-testid="settings-custom-models"], [data-testid="custom-model-dialog"], [data-testid="settings-auxiliary-models"], [data-testid="settings-model-machine"]')).toBeNull();
  expect(page.getByRole('button', { name: '重试', exact: true }).query()).toBeNull();
  expect(document.body.textContent).not.toContain('host bridge');
  await act(async () => { await userEvent.click(page.getByTestId('settings-model-provided-manage')); });
  await expect.element(page.getByTestId('settings-model-usable')).toHaveTextContent('可用平台模型');
  await act(async () => { await userEvent.click(page.getByRole('switch')); });
  expect(state.hidden).toHaveBeenCalledExactlyOnceWith('available', true);
  expect(state.config).not.toHaveBeenCalled();
  expect(state.settings).not.toHaveBeenCalled();
  expect(state.agents).not.toHaveBeenCalled();
});

it('retains the desktop model groups and their add action when the host supports model settings', async () => {
  state.os = 'desktop';
  expect(platform.capabilities.modelSettings).toBe(true);
  state.config.mockResolvedValue({ listCustomModels: async () => ({ success: true, data: [] }) });
  state.settings.mockImplementation(async (key: string) => {
    const value = key === 'autoReviewModel' ? null : { titleModel: 'gugu-fast' };
    return { value, defaults: value, overrides: {} };
  });
  await renderWithAppProviders(harness, <ModelSection />, { auth: { id: 'desktop-models', nickname: '测试账号', avatarUrl: '' }, contacts: {} });
  await until('desktop model configuration is read', () => state.config.mock.calls.length > 0);
  await expect.element(page.getByTestId('settings-coding-plans')).toBeVisible();
  expect(page.getByTestId('settings-api-models').query()).toBeNull();
  await expect.element(page.getByTestId('settings-custom-models')).toBeVisible();
  await expect.element(page.getByTestId('settings-custom-models').getByTestId('settings-model-provided-manage')).toBeVisible();
  expect(page.getByTestId('settings-models-desktop-only').query()).toBeNull();
  await act(async () => { await userEvent.click(page.getByTestId('custom-model-add')); });
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
});

it.each(['zh-CN', 'en-US'] as const)('%s model errors use the shared localized error outlet', locale => {
  setLocalePreference(locale);
  const cause = new Error('[session] host bridge unavailable: the desktop app lacks the preload injection, the web app lacks the task page host connection');
  const wrappedCause = new Error("Error invoking remote method 'models': Error: [session] host bridge unavailable: missing preload\nprivate stack");
  const expected = locale === 'zh-CN'
    ? '暂时无法连接这台设备，请重新打开应用后再试。'
    : 'Cannot connect to this device right now. Reopen the app and try again.';
  expect(errorText(cause)).toBe(messageForUser(cause));
  expect(errorText(cause)).toBe(expected);
  expect(messageForUser(wrappedCause)).toBe(expected);
  expect(errorText({ message: cause.message })).not.toContain('preload');
});
