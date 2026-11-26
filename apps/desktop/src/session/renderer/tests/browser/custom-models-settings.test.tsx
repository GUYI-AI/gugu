import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { queryClient } from '@/lib/replica';
import { UI_EVENTS } from '@/lib/uiEvents';
import { setLocalePreference } from '@/i18n';
import { CustomModelsGroup } from '@/components/settings/CustomModelsGroup';
import { CustomModelDialog } from '@/components/settings/CustomModelDialog';
import { CustomModelRouteRepairHost } from '@/components/settings/CustomModelRouteRepairHost';
import { Sheet } from '@/components/ui/Sheet';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { CUSTOM_MODEL_KEY_CHANNEL, type CustomModelConnection, type CustomModelEffortResult } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList, CustomModelProtocolProbe, SaveCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { connectionTag, customComposerOptions, ownModelTag } from '@renderer/features/sessions/session-config/custom-model-options';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { composerModelFooter, composerSelectedOptionId } from '@renderer/features/sessions/session-config/use-composer-model-options';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/lib/focus-modality';
import { ToastContext } from '@/components/toastContext';
const state = vi.hoisted(() => ({ rows: [] as CustomModelConnection[], saved: null as SaveCustomModel | null, reads: [] as unknown[], probe: null as CustomModelProtocolProbe | null, probes: [] as unknown[], testResult: null as ConnectionModelList | null, agents: [] as unknown[], saveError: null as string | null, toasts: [] as unknown[][] }));
const catalog = vi.hoisted(() => ({ results: new Map<string, CustomModelEffortResult>() }));
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/stores/use-agents')>(),
  useAgents: () => ({ state: 'value', value: state.agents, stale: false, error: null }),
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  listCustomModels: async () => ({ success: true, data: state.rows }),
  lookupCustomModelEfforts: async ({ ids }: { ids: string[] }) => ({ success: true, data: ids.map(id => ({
    id, result: catalog.results.get(id) ?? { kind: 'found', catalogId: id, name: id, efforts: [] },
  })) }),
  testCustomModel: async (input: unknown) => { state.reads.push(input); return { success: true, data: state.testResult ?? { kind: 'unlisted', reason: 'no-list' } }; },
  detectCustomModelProtocols: async (input: unknown) => { state.probes.push(input); return { success: true, data: state.probe }; },
  saveCustomModel: async (input: SaveCustomModel) => { if (state.saveError) return { success: false, error: { message: state.saveError } }; state.saved = input; return { success: true, data: { ...input, id: input.id ?? '481825a8-60b9-4c83-8d1b-f104e3db0269', credentialRef: 'ref', keySaved: true } }; },
}) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { queryClient.clear(); catalog.results.clear(); setLocalePreference('en-US'); state.rows = []; state.saved = null; state.reads = []; state.probe = null; state.probes = []; state.testResult = null; state.agents = []; state.saveError = null; state.toasts = []; host = document.createElement('div'); host.className = 'gugu-skin emlight'; document.body.append(host); root = createRoot(host); });
afterEach(() => { root.unmount(); host.remove(); });
const record = (): CustomModelConnection => ({ id: '481825a8-60b9-4c83-8d1b-f104e3db0269', name: 'Existing provider', credentialRef: 'ref', keySaved: false, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }], models: [] });
const toastSink = { toast: (...args: unknown[]) => { state.toasts.push(args); } };
const render = (content: React.ReactNode) => root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><ToastContext.Provider value={toastSink}>{content}</ToastContext.Provider></SessionLocalizationProvider></QueryClientProvider>);
const isChecked = (testId: string) => document.querySelector(`[data-testid="${testId}"] [data-slot=checkbox]`)?.hasAttribute('data-checked') ?? false;
const settled = () => [...document.querySelectorAll('[data-testid="custom-model-dialog"], [data-slot=select-content]')]
  .every(element => element.getAnimations().every(animation => animation.playState === 'finished'));
const dialogBody = () => document.querySelector<HTMLElement>('.gg-model-dialog-body')!;
async function shot(name: string) {
  await until('the dialog and its menus finish moving', () => {
    const dialog = document.querySelector('[data-testid="custom-model-dialog"]');
    return !!dialog && getComputedStyle(dialog).backgroundColor !== 'rgba(0, 0, 0, 0)' && settled();
  });
  await page.screenshot({ path: `../../../../../../../test-results/custom-model-${name}.png` });
}
it('starts with thinking on and nothing checked; thinking off hides its settings and turning it on starts over', async () => {
  setLocalePreference('zh-CN');
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-effort-hint')).toHaveTextContent('当前仅展示思考开关，不展示强度选择；如需调节强度，请在下方选择可用档位。');
  expect(['tool-call', 'image', 'thinking', 'thinking-only', 'thinking-optional', 'fast', 'custom-protocol'].map(id => isChecked(`custom-model-${id}`)))
    .toEqual([true, false, true, false, true, false, false]);
  await expect.element(page.getByTestId('custom-model-default-effort')).toHaveTextContent('自动');
  expect(page.getByTestId('custom-model-routes').query()).toBeNull();
  await userEvent.click(page.getByTestId('custom-model-thinking-only'));
  await userEvent.click(page.getByTestId('custom-model-effort-low'));
  await userEvent.click(page.getByTestId('custom-model-thinking'));
  for (const id of ['thinking-levels', 'thinking-only', 'thinking-optional']) expect(page.getByTestId(`custom-model-${id}`).query()).toBeNull();
  await userEvent.click(page.getByTestId('custom-model-thinking'));
  expect(['thinking-only', 'thinking-optional', 'effort-low'].map(id => isChecked(`custom-model-${id}`))).toEqual([false, true, false]);
  await expect.element(page.getByTestId('custom-model-default-effort')).toHaveTextContent('自动');
  await expect.element(page.getByTestId('custom-model-effort-hint')).toBeVisible();
});
it('proposes the default from the checked levels and lists only Automatic and those levels', async () => {
  setLocalePreference('zh-CN');
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  const level = (id: string) => userEvent.click(page.getByTestId(`custom-model-effort-${id}`));
  const defaultIs = (text: string) => expect.element(page.getByTestId('custom-model-default-effort')).toHaveTextContent(text);
  await level('low'); await defaultIs('低');
  expect(page.getByTestId('custom-model-effort-hint').query()).toBeNull();
  await level('medium'); await defaultIs('中');
  await level('high'); await defaultIs('高');
  await level('max'); await defaultIs('高');
  await level('high'); await defaultIs('极致');
  await level('max'); await defaultIs('中');
  await userEvent.click(page.getByTestId('custom-model-default-effort'));
  await userEvent.click(page.getByRole('option', { name: '低', exact: true }));
  await level('medium'); await defaultIs('低');
  await level('xhigh'); await defaultIs('超高');
  await userEvent.click(page.getByTestId('custom-model-default-effort'));
  await until('the default menu lists its options', () => document.querySelectorAll('[role=option]').length > 0);
  expect([...document.querySelectorAll('[role=option]')].map(option => option.textContent)).toEqual(['自动', '低', '超高']);
  const selected = page.getByRole('option', { name: '超高', exact: true });
  await until('the open default menu finishes entering', () => {
    const popup = selected.query()?.closest('[data-slot="select-content"]');
    return popup != null && !popup.hasAttribute('data-starting-style') && popup.getAnimations().every(animation => animation.playState === 'finished');
  });
  await userEvent.keyboard('{Escape}');
  await expect.element(page.getByTestId('custom-model-default-effort')).toHaveAttribute('aria-expanded', 'false');
  await level('low'); await level('xhigh'); await defaultIs('自动');
  await expect.element(page.getByTestId('custom-model-effort-hint')).toBeVisible();
});
it('checks the levels models.dev knows for the named model until the person checks their own', async () => {
  catalog.results.set('relay/model', { kind: 'found', catalogId: 'relay/model', name: 'Relay', efforts: ['low', 'high', 'max'] });
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-name'), 'relay/model');
  await until('the catalog levels are checked', () => isChecked('custom-model-effort-high'));
  expect(['low', 'medium', 'high', 'xhigh', 'max'].map(id => isChecked(`custom-model-effort-${id}`))).toEqual([true, false, true, false, true]);
  await expect.element(page.getByTestId('custom-model-default-effort')).toHaveTextContent('High');
  expect(document.body.textContent).not.toContain('models.dev');
});
it('opened with the pointer, its first focus draws no ring; the keyboard brings the ring back', async () => {
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await until('the dialog takes focus', () => !!document.activeElement?.closest('[data-testid="custom-model-dialog"]'));
  expect(document.activeElement?.hasAttribute('data-pointer-focus')).toBe(true);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement?.hasAttribute('data-pointer-focus')).toBe(false);
});
it('draws an unchecked box with a control edge darker than the shared hairline', async () => {
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  const box = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="custom-model-image"] [data-slot=checkbox]');
    if (!element) throw new Error('The image input box is not drawn yet');
    return element;
  });
  const probe = document.createElement('span');
  probe.style.borderColor = 'color-mix(in oklab, var(--fg) 22%, transparent)';
  probe.style.borderStyle = 'solid';
  box.parentElement!.append(probe);
  try { expect(getComputedStyle(box).borderTopColor).toBe(getComputedStyle(probe).borderTopColor); } finally { probe.remove(); }
});
it('shows the routes under Custom protocol, and says under the box that unchecking it removes them on save', async () => {
  setLocalePreference('zh-CN');
  const route = { id: 'd5bd45f0-f968-4df8-bf00-e7d303cab020', incoming: 'any', outgoing: 'openai-chat-completions' } as const;
  const connection: CustomModelConnection = { ...record(), keySaved: true, models: [{ id: 'm' }], endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], routes: [route] };
  state.probe = { endpoints: connection.endpoints, models: ['m'], failures: [] };
  await page.viewport(1100, 860);
  document.documentElement.dataset.theme = 'light';
  host.className = 'gugu-skin emlight';
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  render(<UiPortalContainerProvider value={host}><CustomModelDialog machine={null} connection={connection} modelId="m" onClose={() => {}} /></UiPortalContainerProvider>);
  await expect.element(page.getByTestId('custom-model-route-incoming-0')).toBeVisible();
  expect(isChecked('custom-model-custom-protocol')).toBe(true);
  expect(page.getByTestId('custom-model-drop-routes').query()).toBeNull();
  const remove = page.getByRole('button', { name: '删除第 1 条路由' }).element().getBoundingClientRect();
  expect(Math.min(remove.width, remove.height)).toBeGreaterThanOrEqual(24);
  await userEvent.click(page.getByTestId('custom-model-custom-protocol'));
  expect(page.getByTestId('custom-model-routes').query()).toBeNull();
  const note = page.getByTestId('custom-model-drop-routes');
  await expect.element(note).toHaveTextContent('保存后会删除已有的 1 条协议路由');
  // The note sits right under its box, its text starting where the box's label text starts, in the warning colour.
  const textBox = (element: Element) => { const range = document.createRange(); range.selectNodeContents([...element.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent!.trim())!); return range.getBoundingClientRect(); };
  const label = textBox(page.getByTestId('custom-model-custom-protocol').element()), hint = textBox(note.element());
  expect(Math.abs(hint.left - label.left)).toBeLessThan(0.5);
  expect(hint.top - label.bottom).toBeGreaterThanOrEqual(0);
  expect(hint.top - label.bottom).toBeLessThan(8);
  const warn = document.createElement('span');
  warn.style.color = 'var(--warn-fg)';
  note.element().append(warn);
  try { expect(getComputedStyle(note.element()).color).toBe(getComputedStyle(warn).color); } finally { warn.remove(); }
  await shot('drop-routes-note');
  await userEvent.click(page.getByTestId('custom-model-custom-protocol'));
  expect(note.query()).toBeNull();
  await expect.element(page.getByTestId('custom-model-route-incoming-0')).toBeVisible();
  expect(document.querySelectorAll('[data-testid^=custom-model-route-incoming-]')).toHaveLength(1);
  await userEvent.click(page.getByTestId('custom-model-custom-protocol'));
  await expect.element(note).toBeVisible();
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved?.routes).toEqual([]);
  delete document.documentElement.dataset.theme;
});
it('saves every declared field, keeps the other models, and reads them back', async () => {
  const connection: CustomModelConnection = { ...record(), keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], models: [{ id: 'old', image: false }, { id: 'kept', maxOutput: 9 }] };
  state.probe = { endpoints: connection.endpoints, models: [], failures: [] };
  render(<CustomModelDialog machine={null} connection={connection} modelId="old" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-name')).toHaveValue('old');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'relay/model');
  for (const id of ['tool-call', 'image', 'thinking-only', 'effort-low', 'effort-high', 'fast']) await userEvent.click(page.getByTestId(`custom-model-${id}`));
  await userEvent.click(page.getByRole('button', { name: '128K', exact: true }));
  await userEvent.click(page.getByRole('button', { name: '16K', exact: true }));
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  const declared = { id: 'relay/model', toolCall: false, image: true, thinking: true, thinkingOnly: true, thinkingOptional: true, fast: true, efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 131_072, maxOutput: 16_384 };
  expect(state.saved?.models).toEqual([declared, { id: 'kept', maxOutput: 9 }]);
  expect(state.saved).not.toHaveProperty('apiKey');
  root.unmount(); root = createRoot(host);
  render(<CustomModelDialog machine={null} connection={{ ...connection, models: state.saved!.models }} modelId="relay/model" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-default-effort')).toHaveTextContent('High');
  expect(['tool-call', 'image', 'thinking', 'thinking-only', 'thinking-optional', 'fast', 'effort-low', 'effort-medium', 'effort-high'].map(id => isChecked(`custom-model-${id}`)))
    .toEqual([false, true, true, true, true, true, true, false, true]);
  await expect.element(page.getByTestId('custom-model-contextWindow')).toHaveValue('128K');
  await expect.element(page.getByRole('button', { name: '16K', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
it('offers Fast only for an address that answers OpenAI Chat or Responses', async () => {
  state.probe = { endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://relay.test' }], models: [], failures: [] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-fast')).toBeVisible();
  expect(page.getByTestId('custom-model-fast').element().hasAttribute('data-disabled')).toBe(false);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await until('Fast turns unavailable for an Anthropic-only address', () => page.getByTestId('custom-model-fast').element().hasAttribute('data-disabled'));
  expect(isChecked('custom-model-fast')).toBe(false);
});
it('choosing another provider puts the advanced configuration back', async () => {
  render(<CustomModelDialog machine={null} group="api" onClose={() => {}} />);
  await userEvent.click(page.getByTestId('custom-model-image'));
  await userEvent.click(page.getByTestId('custom-model-tool-call'));
  await userEvent.click(page.getByTestId('custom-model-provider'));
  await userEvent.click(page.getByRole('option', { name: 'OpenAI', exact: true }));
  expect(['tool-call', 'image', 'thinking', 'custom-protocol'].map(id => isChecked(`custom-model-${id}`))).toEqual([true, false, false, false]);
  expect(page.getByTestId('custom-model-thinking-levels').query()).toBeNull();
});
for (const theme of ['light', 'dark'] as const) {
  it(`captures the dialog states in the ${theme} theme`, async () => {
    await page.viewport(1100, 860);
    setLocalePreference('zh-CN');
    document.documentElement.dataset.theme = theme;
    host.className = `gugu-skin em${theme}`;
    try {
      state.probe = { endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://api.example.com/v1' }], models: [], failures: [] };
      // Opened the way a person opens it: with the pointer, so its first focus carries no keyboard ring.
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      render(<UiPortalContainerProvider value={host}><CustomModelDialog machine={null} group="custom" onClose={() => {}} /></UiPortalContainerProvider>);
      await shot(`${theme}-1-start`);
      dialogBody().scrollTop = dialogBody().scrollHeight;
      await userEvent.click(page.getByTestId('custom-model-thinking'));
      await shot(`${theme}-2-thinking-off`);
      await userEvent.click(page.getByTestId('custom-model-thinking'));
      for (const id of ['low', 'medium', 'high']) await userEvent.click(page.getByTestId(`custom-model-effort-${id}`));
      dialogBody().scrollTop = page.getByTestId('custom-model-advanced').element().getBoundingClientRect().top - dialogBody().getBoundingClientRect().top + dialogBody().scrollTop - 8;
      await userEvent.click(page.getByTestId('custom-model-default-effort'));
      await until('the default menu opens', () => document.querySelectorAll('[role=option]').length === 4);
      await shot(`${theme}-3-levels-menu`);
      await userEvent.keyboard('{Escape}');
      await userEvent.click(page.getByTestId('custom-model-custom-protocol'));
      await expect.element(page.getByTestId('custom-model-route-incoming-0')).toBeVisible();
      dialogBody().scrollTop = page.getByTestId('custom-model-advanced').element().getBoundingClientRect().top - dialogBody().getBoundingClientRect().top + dialogBody().scrollTop - 8;
      await shot(`${theme}-4-custom-protocol`);
    } finally { delete document.documentElement.dataset.theme; }
  });
}
it('opens model settings from the composer without requesting the add-model dialog', () => {
  const onOpen = vi.fn<(event: Event) => void>();
  window.addEventListener(UI_EVENTS.openSettings, onOpen, { once: true });
  try {
    composerModelFooter([]).onManageModels();
    expect(onOpen).toHaveBeenCalledTimes(1);
    const event = onOpen.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).detail).toEqual({ section: 'model', action: undefined });
  } finally {
    window.removeEventListener(UI_EVENTS.openSettings, onOpen);
  }
});
it('shows migrated records with no model or key and a repair entrypoint', async () => {
  state.rows = [record()];
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  const row = () => document.querySelector('[data-custom-connection]');
  await until('the device record renders inside Settings', () => !!row());
  expect(row()?.textContent).toContain('This custom provider has no model selected yet');
  expect(row()?.textContent).toContain('No key saved on this device');
  await userEvent.click(page.getByRole('button', { name: 'Enter key on this computer', exact: true }));
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  await expect.element(page.getByTestId('custom-model-key')).toHaveFocus();
  await expect.element(page.getByTestId('custom-model-provider')).toHaveTextContent('Custom');
  expect(document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')?.value).toBe('');
});
it('keeps coding plans separate and groups API and custom models by their connections', async () => {
  state.rows = [
    { ...record(), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://plan.test/v1' }], id: 'plan', preset: 'kimi-coding', keySaved: true, models: [{ id: 'plan-model' }] },
    { ...record(), endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.test/v1' }], id: 'api', preset: 'deepseek', keySaved: true, models: [{ id: 'api-model' }] },
    { ...record(), id: 'custom', preset: 'old-relay', keySaved: true, models: [{ id: 'relay-model' }] },
  ];
  render(<CustomModelsGroup />);
  await until('all three existing connections render', () => document.querySelectorAll('[data-custom-connection]').length === 3);
  expect(document.querySelector('[data-custom-connection="plan"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-coding-plans');
  expect(document.querySelector('[data-custom-connection="api"]')?.closest('section')?.getAttribute('data-testid')).toBe('settings-custom-models');
  const custom = document.querySelector('[data-custom-connection="custom"]')!;
  expect(custom.closest('section')?.getAttribute('data-testid')).toBe('settings-custom-models');
  expect(custom.textContent).toContain('Existing provider');
});
it.each([
  ['coding-plan', 'Add plan', 'Claude subscription', 'ChatGPT subscription', 'DeepSeek'],
  ['api', 'Add API key', 'DeepSeek', 'OpenAI', 'Claude subscription'],
] as const)('the %s dialog offers only providers from its own card', async (group, title, first, second, absent) => {
  render(<CustomModelDialog machine={null} group={group} onClose={() => {}} />);
  await expect.element(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId('custom-model-provider'));
  await expect.element(page.getByRole('option', { name: first, exact: true })).toBeVisible();
  await expect.element(page.getByRole('option', { name: second, exact: true })).toBeVisible();
  expect(page.getByRole('option', { name: absent, exact: true }).query()).toBeNull();
});
it('edits an address and model name with the saved key without returning the key', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'model:a' }] };
  state.probe = { endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  const closed = vi.fn(); render(<CustomModelDialog machine={null} connection={existing} modelId="model:a" onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://edited.test/v1/responses');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'provider/model:b');
  await until('the address is probed with the saved key', () => state.probes.some(probe => JSON.stringify(probe) === JSON.stringify({ connectionId: existing.id, baseUrl: 'https://edited.test/v1' })));
  await userEvent.click(page.getByTestId('custom-model-test'));
  await expect.element(page.getByTestId('custom-model-test-result')).toHaveTextContent('Connected');
  expect(state.probes).toContainEqual({ connectionId: existing.id, baseUrl: 'https://edited.test/v1', modelId: 'provider/model:b' });
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ id: existing.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }], models: [{ id: 'provider/model:b' }] });
  expect(state.saved?.models).toHaveLength(1);
  expect(state.saved).not.toHaveProperty('apiKey'); expect(closed).toHaveBeenCalledOnce();
});
it('edits the protocol and model in one row and asks for an address only when the main one cannot serve the route', async () => {
  state.probe = { endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://provider.test' }, { protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], models: ['m'], failures: [] };
  render(<CustomModelDialog machine={null} connection={{ ...record(), keySaved: true, models: [{ id: 'm' }] }} modelId="m" onClose={() => {}} />);
  await userEvent.click(page.getByTestId('custom-model-custom-protocol'));
  await userEvent.click(page.getByTestId('custom-model-route-incoming-0'));
  await userEvent.click(page.getByRole('option', { name: 'Anthropic API' }));
  await userEvent.click(page.getByTestId('custom-model-route-model-0'));
  await userEvent.click(page.getByRole('option', { name: 'm', exact: true }));
  await userEvent.click(page.getByTestId('custom-model-route-outgoing-0'));
  await userEvent.click(page.getByRole('option', { name: 'OpenAI Chat' }));
  await until('the main address answers OpenAI Chat, so the route needs no address', () => !document.querySelector('[data-testid=custom-model-route-address-0]'));
  await userEvent.click(page.getByTestId('custom-model-route-outgoing-0'));
  await userEvent.click(page.getByRole('option', { name: 'OpenAI Responses' }));
  await expect.element(page.getByTestId('custom-model-route-address-0')).toBeVisible();
  expect(document.querySelector('[data-testid=custom-model-route-address-0]')?.closest('.grid')).toBe(
    document.querySelector('[data-testid=custom-model-route-model-0]')?.closest('.grid'),
  );
  await userEvent.fill(page.getByTestId('custom-model-route-address-0'), 'https://provider.test/compat/v1');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, routes: [{
    incoming: 'anthropic-messages', outgoing: 'openai-responses', modelId: 'm', baseUrl: 'https://provider.test/compat/v1',
  }] });
});

it('repairs a missing model route from its disabled row and returns to the picker after save', async () => {
  await page.viewport(1400, 800);
  const fallback = { id: 'd5bd45f0-f968-4df8-bf00-e7d303cab020', incoming: 'openai-responses', outgoing: 'openai-chat-completions' } as const;
  const connection: CustomModelConnection = {
    ...record(), keySaved: true, models: [{ id: 'repair-target' }, { id: 'other-model' }],
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1' }], routes: [fallback],
  };
  const agent = { id: 'claude', name: 'Claude', capabilities: {
    modelProtocols: ['anthropic-messages' as const], customModel: { convertFrom: ['openai-chat-completions' as const] },
  } };
  state.probe = { endpoints: connection.endpoints, models: connection.models.map(({ id }) => id), failures: [] };
  const options = customComposerOptions([connection], agent, translateSessionMessage, null);
  const onModelChange = vi.fn();
  render(<><div style={{ position: 'fixed', inset: 0, zIndex: 5 }}>
    <div style={{ position: 'absolute', right: 24, bottom: 24, width: 640 }}>
      <ChatComposer modelOptions={{ 'platform:available-model': { name: 'Available model' }, ...options }}
        selectedModel="platform:available-model" onModelChange={onModelChange} onSubmit={() => {}} onStop={() => {}} />
    </div>
  </div><CustomModelRouteRepairHost /></>);

  const panel = () => document.querySelector<HTMLElement>('[data-slot="combobox-content"]');
  await until('the model trigger mounts', () => !!document.querySelector('[data-testid="composer-model-trigger"]'));
  document.querySelector<HTMLButtonElement>('[data-testid="composer-model-trigger"]')!.click();
  await until('the model menu finishes opening', () => !!panel() && panel()!.getAnimations().every(({ playState }) => playState === 'finished'));
  const row = page.getByRole('option', { name: /repair-target/ });
  await expect.element(row).toHaveAttribute('aria-disabled', 'true');
  await row.hover();
  await page.getByRole('button', { name: 'Add route for this model', exact: true }).click();
  await expect.element(page.getByTestId('custom-model-dialog')).toBeVisible();
  await expect.element(page.getByTestId('custom-model-route-incoming-0')).toHaveTextContent('Anthropic API');
  await expect.element(page.getByTestId('custom-model-route-outgoing-0')).toHaveTextContent('OpenAI Chat');
  await expect.element(page.getByTestId('custom-model-route-model-0')).toHaveTextContent('repair-target');
  expect(state.saved).toBeNull();
  await until('the route repair dialog finishes opening with Save above the composer', () => {
    const dialog = document.querySelector('[data-testid="custom-model-dialog"]');
    const save = dialog?.querySelector<HTMLButtonElement>('[data-testid="custom-model-save"]');
    if (!dialog || !save || dialog.getAnimations().some(animation => animation.playState !== 'finished')) return false;
    const { x, y, width, height } = save.getBoundingClientRect();
    return save.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  });
  await page.screenshot({ path: '../../../../../../../test-results/custom-route-repair-save.png' });
  await userEvent.click(page.getByTestId('custom-model-save'));
  await expect.element(row).toBeVisible();
  await expect.element(row).toHaveAttribute('data-route-repair-target', 'true');
  const routes = state.saved?.routes;
  expect(routes).toMatchObject([{ incoming: 'anthropic-messages', outgoing: 'openai-chat-completions', modelId: 'repair-target' }, fallback]);
  const updated = Object.values(customComposerOptions([{ ...connection, routes }], agent, translateSessionMessage));
  expect(updated.map(({ name, disabled }) => [name, disabled])).toEqual([['repair-target', undefined], ['other-model', true]]);
  expect(onModelChange).not.toHaveBeenCalled();
});

it('draws a logo on every own-connection row: the preset, else the maker of the model it serves (owner 11-25)', () => {
  const pi = { id: 'pi', name: 'Pi', capabilities: { modelProtocols: ['openai-responses' as const], customModel: undefined } };
  const relay: CustomModelConnection = { ...record(), keySaved: true, name: 'OpenRouter',
    endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://openrouter.ai/api/v1' }],
    models: [{ id: 'qwen/qwen3-coder-480b-a35b-instruct' }, { id: 'house-model-7' }] };
  const icons = Object.values(customComposerOptions([relay], pi, translateSessionMessage))
    .map(({ name, icon }) => [name, (icon as React.ReactElement<{ 'data-provider-id'?: string }> | null | undefined)?.props?.['data-provider-id'] ?? null]);
  // An unknown maker leaves the row to the menu's generic icon (pinned in composer-model-menu-3249).
  expect(icons).toEqual([['qwen/qwen3-coder-480b-a35b-instruct', 'qwen'], ['house-model-7', null]]);
});

it('names only the bound model when reopening a migrated Pi task', async () => {
  const existing = { ...record(), keySaved: true, models: [{ id: 'glm-5.3-flash' }] };
  const duplicate = { ...existing, id: '48937c18-1219-460e-9f40-e08d70de94a5', name: 'Other provider' };
  const models = customComposerOptions([duplicate, existing], {
    id: 'pi', name: 'Pi', capabilities: { modelProtocols: ['openai-responses'], customModel: undefined },
  }, translateSessionMessage);
  const selectedModel = composerSelectedOptionId({
    model: 'gugu-' + existing.id + '/glm-5.3-flash',
    customModel: { kind: 'custom', connectionId: existing.id, modelId: 'glm-5.3-flash' },
  });
  render(<ChatComposer modelOptions={models} selectedModel={selectedModel} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await until('the trigger names the bound model', () => document.querySelector('[data-slot=composer-model-trigger-label]')?.textContent === 'glm-5.3-flash');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('provider');
});
it('a custom address shows no protocol and saves the addresses it recognized for the named model', async () => {
  state.probe = {
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }, { protocol: 'openai-responses', baseUrl: 'https://relay.test' }],
    models: ['model-a', 'model-b'], failures: [{ step: 'anthropic-messages', reason: 'refused' }],
  };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'model-b');
  await until('the address is probed', () => state.probes.some(probe => JSON.stringify(probe) === JSON.stringify({ apiKey: 'sk-test', baseUrl: 'https://relay.test' })));
  expect(document.querySelector('[data-testid^=custom-model-protocol]')).toBeNull();
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: state.probe.endpoints, models: [{ id: 'model-b', toolCall: true, image: false, thinking: true, efforts: [] }], apiKey: 'sk-test', routes: [] });
});
// owner 2026-11-27 03:17: routing is automatic; the dialog says in one line what the address takes, Responses first.
it('says in one line which protocols a custom address takes, Responses first, and nothing when it took none', async () => {
  state.probe = {
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }, { protocol: 'openai-responses', baseUrl: 'https://relay.test/v1' }],
    models: ['m'], failures: [],
  };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await expect.element(page.getByTestId('custom-model-recognized')).toHaveTextContent('Recognized: takes OpenAI Responses, OpenAI Chat');
  expect(document.querySelector('[data-testid=custom-model-routes]')).toBeNull();
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://other.test/v1');
  await until('the new address is probed', () => state.probes.some(probe => JSON.stringify(probe).includes('other.test')));
  await expect.element(page.getByTestId('custom-model-recognized')).not.toBeInTheDocument();
});
const failures = [
  ['unauthorized', 'This address refused the key.', '该地址拒绝了此 Key。'],
  ['unreachable', 'Cannot reach this address.', '无法连接到该地址。'],
  ['dns', 'Cannot resolve this hostname.', '无法解析这个域名。'],
  ['timeout', 'The connection timed out.', '连接超时。'],
  ['certificate', 'Cannot verify this address’s certificate.', '无法验证这个地址的证书。'],
  ['connection-refused', 'The connection was refused.', '连接被拒绝。'],
  ['redirect', 'This address redirects; enter the final one.', '这个地址会跳转，请填最终地址。'],
  ['proxy', 'The proxy cannot be used.', '代理用不了。'],
] as const;
for (const locale of ['en-US', 'zh-CN'] as const) {
  it.each(failures)(`${locale} shows the specific %s diagnosis without collapsing it into unreachable`, async (reason, en, zh) => {
    setLocalePreference(locale);
    state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason }, { step: 'openai-chat-completions', reason: 'no-model' }] };
    render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
    await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
    await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
    expect(page.getByTestId('custom-model-test-result').query()).toBeNull();
    await userEvent.click(page.getByTestId('custom-model-test'));
    await expect.element(page.getByTestId('custom-model-test-result')).toHaveTextContent(locale === 'en-US' ? en : zh);
    expect(document.querySelector('[data-testid=custom-model-key]')?.getAttribute('aria-invalid')).toBe('true');
    expect(page.getByTestId('custom-model-test-result').element().textContent).not.toContain('sk-test');
  });
}
it.each(failures)('the saved connection’s Test connection action preserves %s', async (reason, text) => {
  state.rows = [{ ...record(), keySaved: true, models: [{ id: 'model' }] }];
  state.testResult = { kind: 'unlisted', reason };
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  await userEvent.click(page.getByRole('button', { name: 'Test connection', exact: true }));
  await expect.element(page.getByRole('status')).toHaveTextContent(text);
});
const found = (): CustomModelConnection => ({ ...record(), id: 'found', name: 'OpenAI', preset: 'openai', keySaved: true, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }], discovered: { source: 'shell-env', keyLast4: 'abcd' } });
// A platform preset has no address field: 「check this address」 sends the person to a field that is not there (B7-F03).
for (const [locale, text] of [['en-US', 'Could not read the model list.'], ['zh-CN', '读不到模型列表。']] as const) {
  it(`${locale} says a preset's unread model list as what is known, not as an address to check`, async () => {
    setLocalePreference(locale);
    state.testResult = { kind: 'unlisted', reason: 'unreachable' };
    render(<CustomModelDialog machine={null} group="api" connection={found()} onClose={() => {}} />);
    await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent(text);
    expect(document.querySelector('[data-testid=custom-model-address-0]')).toBeNull();
  });
}
it('the saved preset connection’s Test connection action says the unread list the same way', async () => {
  state.rows = [{ ...record(), id: 'preset', name: 'OpenAI', preset: 'openai', keySaved: true, models: [{ id: 'model' }] }];
  state.testResult = { kind: 'unlisted', reason: 'dns' };
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  await userEvent.click(page.getByRole('button', { name: 'Test connection', exact: true }));
  await expect.element(page.getByRole('status')).toHaveTextContent('Could not read the model list.');
});
const keyField = () => document.querySelector<HTMLInputElement>('[data-testid=custom-model-key]')!;
it('shows the key this computer holds when the eye is pressed, and reads with it until a new one is typed', async () => {
  const invoke = vi.fn(async (channel: string, id: unknown) => { if (channel !== CUSTOM_MODEL_KEY_CHANNEL || id !== 'found') throw new Error(channel); return 'sk-found-0000abcd'; });
  vi.stubGlobal('electronAPI', { invoke });
  try {
    state.testResult = { kind: 'unlisted', reason: 'unauthorized' };
    render(<CustomModelDialog machine={null} group="api" connection={found()} onClose={() => {}} />);
    await expect.element(page.getByTestId('custom-model-key')).toHaveAttribute('placeholder', '••••••••abcd');
    await userEvent.click(page.getByTestId('custom-model-test'));
    await expect.element(page.getByTestId('custom-model-test-result')).toHaveTextContent('This address refused the key; enter a new one.');
    await userEvent.click(page.getByRole('button', { name: 'Show key' }));
    await expect.element(page.getByTestId('custom-model-key')).toHaveValue('sk-found-0000abcd');
    expect(keyField().type).toBe('text');
    await userEvent.click(page.getByRole('button', { name: 'Hide key' }));
    expect(keyField().type).toBe('password');
    expect(state.reads).toContainEqual({ connectionId: 'found', endpoints: found().endpoints });
    await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-typed');
    expect(page.getByTestId('custom-model-test-result').query()).toBeNull();
    await userEvent.click(page.getByTestId('custom-model-test'));
    await expect.element(page.getByTestId('custom-model-test-result')).toHaveTextContent('This address refused the key.');
    expect(state.reads).toContainEqual({ apiKey: 'sk-typed', endpoints: found().endpoints });
  } finally { vi.unstubAllGlobals(); }
});
it('a new model offers the eye on an empty key field and it shows the typed key', async () => {
  render(<CustomModelDialog machine="device-1" group="custom" onClose={() => {}} />);
  await expect.element(page.getByRole('button', { name: 'Show key' })).toBeVisible();
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-typed');
  await userEvent.click(page.getByRole('button', { name: 'Show key' }));
  await expect.element(page.getByTestId('custom-model-key')).toHaveAttribute('type', 'text');
});
it('a connection on another device shows only the end of its key, with no eye', async () => {
  vi.stubGlobal('electronAPI', { invoke: vi.fn() });
  try {
    render(<CustomModelDialog machine="device-1" group="api" connection={found()} onClose={() => {}} />);
    await expect.element(page.getByTestId('custom-model-key')).toHaveAttribute('placeholder', '••••••••abcd');
    expect(page.getByRole('button', { name: 'Show key' }).query()).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
it('a connection failure that first occurs during the save-time named-model probe does not stop the save; it is kept as the reason', async () => {
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'no-list' }] };
  const closed = vi.fn();
  render(<CustomModelDialog machine={null} group="custom" onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'my-model');
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'dns' }, { step: 'openai-chat-completions', reason: 'dns' }] };
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved and closed', () => state.saved !== null && closed.mock.calls.length === 1);
  expect(state.saved).toMatchObject({ endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], unverified: true, apiKey: 'sk-test' });
  expect(state.saved?.unverifiedReason).toEqual({ reason: 'dns', modelId: 'my-model' });
  expect(state.toasts).toEqual([]);
});
it('an address the background check could not resolve is said before saving, and saved unverified with the same reason', async () => {
  state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason: 'dns' }] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'my-model');
  await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent('Cannot resolve this hostname.');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.probes.some(probe => (probe as { modelId?: string }).modelId === 'my-model')).toBe(true);
  expect(state.saved).toMatchObject({ unverified: true, unverifiedReason: { reason: 'dns', modelId: 'my-model' } });
  expect(state.toasts).toEqual([]);
});
it('a converted third-party model is selectable and tagged with its vendor; an IP address gets no tag', async () => {
  const chat = (id: string, baseUrl: string, model: string): CustomModelConnection => ({ ...record(), id, name: id, keySaved: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl }], models: [{ id: model }] });
  const models = customComposerOptions([
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0001', 'https://api.deepseek.com/v1', 'deepseek-v4-flash'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0002', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'),
    chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0003', 'http://10.0.0.8:8000/v1', 'local-model'),
    { ...chat('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0004', 'https://no-key.example/v1', 'hidden-model'), keySaved: false },
  ], { id: 'claude', name: 'Claude', capabilities: { modelProtocols: ['anthropic-messages'], customModel: { convertFrom: ['openai-chat-completions'] } } }, translateSessionMessage);
  expect(Object.values(models).map(({ tag, disabled }) => [tag, disabled])).toEqual([['deepseek', undefined], ['bigmodel', undefined], [undefined, undefined]]);
  render(<ChatComposer modelOptions={models} selectedModel={Object.keys(models)[0]} onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}} />);
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  await until('the tags render', () => document.querySelectorAll('[data-slot=composer-model-tag]').length === 2);
  expect([...document.querySelectorAll('[data-slot=composer-model-tag]')].map((tag) => tag.textContent)).toEqual(['deepseek', 'bigmodel']);
  // The trigger names only the model: nothing of the vendor besides the model's own label.
  expect(document.querySelector('[data-slot=composer-model-trigger-label]')?.textContent).toBe('deepseek-v4-flash');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent?.replace('deepseek-v4-flash', '')).not.toContain('deepseek');
  expect(document.querySelector('[data-testid=composer-model-trigger]')?.textContent).not.toContain('·');
});
it('#1552: configurations sharing an address, key and provider are numbered alike in the menu and Settings; a lone one is not', async () => {
  const at = (id: string, baseUrl: string, model: string): CustomModelConnection => ({ ...record(), id, name: 'OpenAI', preset: 'openai', keySaved: true,
    endpoints: [{ protocol: 'openai-responses', baseUrl }], models: [{ id: model }] });
  const openai = 'https://api.openai.com/v1';
  state.rows = [
    at('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0011', openai, 'gpt-luna'),
    at('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0012', openai, 'gpt-astra'),
    { ...at('e7d4a5a8-6f1e-4b52-9a51-0d4d1d0d0013', 'https://api.deepseek.com/v1', 'deepseek-v4'), name: 'DeepSeek', preset: 'deepseek' },
  ];
  const codex = { id: 'codex', name: 'Codex', capabilities: { modelProtocols: ['openai-responses' as const], customModel: undefined } };
  const menu = Object.values(customComposerOptions(state.rows, codex, translateSessionMessage));
  expect(menu.map(({ name, tag, providerLabel }) => [name, tag, providerLabel])).toEqual([
    ['gpt-luna', 'openai 1', 'openai 1'], ['gpt-astra', 'openai 2', 'openai 2'], ['deepseek-v4', 'deepseek', 'deepseek'],
  ]);
  expect(Object.values(customComposerOptions(state.rows.slice(1), codex, translateSessionMessage))[0]).toMatchObject({ tag: 'openai' });
  render(<CustomModelsGroup />);
  await until('all three configurations render', () => document.querySelectorAll('[data-custom-connection]').length === 3);
  expect(state.rows.map(({ id }) => document.querySelector(`[data-custom-connection="${id}"]`)?.textContent)).toEqual([
    expect.stringContaining('OpenAI 1'), expect.stringContaining('OpenAI 2'), expect.not.stringContaining('DeepSeek 1'),
  ]);
  expect(document.body.textContent).not.toContain('Choose API key');
});
it('owner 11-24: a coding plan says whose plan; pay-as-you-go says its domain, preset or typed', () => {
  const tag = (id: string, baseUrl?: string) => connectionTag(providerPresets.find((preset) => preset.id === id), baseUrl);
  // A key does not tell its tier: the vendor only, ❌ 「Coding Plan」, ❌ the domain.
  expect(['zhipu-coding', 'kimi-coding', 'ark-coding', 'zai-coding'].map((id) => tag(id))).toEqual(['Zhipu', 'Kimi', 'Volcengine Ark', 'Z.ai']);
  // owner 11-25 20:45: pay-as-you-go is the domain without the suffix, a preset too (❌ the service's name).
  const domain = (id: string) => tag(id, providerPresets.find((preset) => preset.id === id)?.endpoints[0]?.baseUrl);
  expect(['openai', 'deepseek', 'zhipu'].map(domain)).toEqual(['openai', 'deepseek', 'bigmodel']);
  expect(connectionTag(undefined, 'https://api.example-relay.com/v1')).toBe('example-relay');
  expect(connectionTag(undefined, 'http://10.0.0.8:8000/v1')).toBeUndefined();
  setLocalePreference('zh-CN');
  expect(['zhipu-coding', 'ark-coding'].map((id) => tag(id))).toEqual(['智谱', '火山方舟']);
});

it('owner 11-24: own models say the plan as sold, the vendor while the tier is unread, the API domain on a key', () => {
  expect(ownModelTag('codex', { credentialKind: 'subscription', plan: { payer: 'subscription', plan: 'ChatGPT Plus' } })).toBe('ChatGPT Plus');
  expect(ownModelTag('claude', { credentialKind: 'subscription', plan: { payer: 'subscription', plan: 'Claude Max 20x' } })).toBe('Claude Max 20x');
  // Not read yet, or unreadable: the vendor, ❌ no tag and ❌ 「Coding Plan」.
  expect(ownModelTag('codex', { credentialKind: 'subscription' })).toBe('ChatGPT');
  expect(ownModelTag('claude', { plan: { payer: 'unknown' } })).toBe('Claude');
  expect(ownModelTag('codex', { credentialKind: 'api-key' })).toBe('openai');
  expect(ownModelTag('claude', { plan: { payer: 'api-key' } })).toBe('anthropic');
  expect(ownModelTag('claude', { plan: { payer: 'custom-endpoint', endpoint: 'relay.example.com' } })).toBe('example');
  expect(ownModelTag('pi', { credentialKind: 'subscription' })).toBeUndefined();
});
// owner 2026-11-26 20:12/20:32/20:46: the person typed this key, so a refusal does not stop the save or drop the key, and no
// format is asked: the first path that answered 401/403 exists, so it is that one; none did ⇒ OpenAI Chat at the address as
// typed. The connection is marked unverified; the red line stays as a note. Unreachable or timed-out addresses still stop the save.
const refusedProbe = (refused?: CustomModelProtocolProbe['refused']): CustomModelProtocolProbe => ({
  endpoints: [], models: [], failures: [{ step: 'models', reason: 'unauthorized' }], ...(refused ? { refused } : {}),
});
async function fillRefused() {
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-refused');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'relay/model');
}
it('a refused key does not stop the save: it keeps the key, saves the path that answered 401 and marks it unverified', async () => {
  setLocalePreference('zh-CN');
  state.probe = refusedProbe([{ protocol: 'anthropic-messages', baseUrl: 'https://relay.test' }]);
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await fillRefused();
  await expect.element(page.getByTestId('custom-model-key-problem')).toHaveTextContent('该地址拒绝了此 Key。');
  expect(page.getByRole('button', { name: /仍然/ }).query()).toBeNull();
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://relay.test' }], unverified: true, apiKey: 'sk-refused', models: [{ id: 'relay/model' }] });
});
it('a refusal that tells no path apart is saved as OpenAI Chat at the address as typed', async () => {
  state.probe = refusedProbe();
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await fillRefused();
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved).toMatchObject({ endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], unverified: true, apiKey: 'sk-refused' });
});
for (const reason of ['timeout', 'unreachable'] as const) {
  it(`an address that answers with ${reason} is saved unverified, and the reason is said (owner 11-27)`, async () => {
    state.probe = { endpoints: [], models: [], failures: [{ step: 'models', reason }] };
    render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
    await fillRefused();
    await userEvent.click(page.getByTestId('custom-model-save'));
    await until('the form saved', () => state.saved !== null);
    expect(state.saved).toMatchObject({ endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], unverified: true });
    expect(state.saved?.unverifiedReason).toEqual({ reason, modelId: 'relay/model' });
    expect(state.toasts).toEqual([]);
  });
}
it('a save the address answers clears the unverified record, and the list marks none (owner 11-27)', async () => {
  state.probe = { endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], models: [], failures: [] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await fillRefused();
  await until('the address is probed', () => state.probes.length > 0);
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved?.unverified).toBe(false);
  root.unmount(); root = createRoot(host);
  state.rows = [{ ...record(), keySaved: true, unverified: true, models: [{ id: 'model' }] }];
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  await expect.element(page.getByText('Existing provider')).toBeVisible();
  expect(document.body.textContent).not.toMatch(/verified/i);
});
for (const theme of ['light', 'dark'] as const) {
  it(`captures a refused key that still saves in the ${theme} theme`, async () => {
    await page.viewport(1100, 860);
    setLocalePreference('zh-CN');
    document.documentElement.dataset.theme = theme;
    host.className = `gugu-skin em${theme}`;
    try {
      state.probe = refusedProbe();
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      render(<UiPortalContainerProvider value={host}><CustomModelDialog machine={null} group="custom" onClose={() => {}} /></UiPortalContainerProvider>);
      await fillRefused();
      await expect.element(page.getByTestId('custom-model-key-problem')).toBeVisible();
      await shot(`${theme}-key-refused`);
      state.rows = [{ ...record(), name: 'relay.test', keySaved: true, unverified: true, endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], models: [{ id: 'relay/model' }] }];
      root.unmount(); root = createRoot(host);
      render(<UiPortalContainerProvider value={host}><Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet></UiPortalContainerProvider>);
      await expect.element(page.getByText('relay.test')).toBeVisible();
      expect(document.body.textContent).not.toContain('未验证');
      await page.screenshot({ path: `../../../../../../../test-results/custom-model-${theme}-unverified-row.png` });
    } finally { document.documentElement.dataset.theme = 'light'; }
  });
}

// owner 11-27 02:38 / 02:53: one 「最大上下文」 with 300K / 600K / 900K beside 「输入」; values read as 1M / 300K, never raw digits.
it('saves one max context as the menu lengths, shows tokens as K / M, and presses no tier when empty', async () => {
  const connection: CustomModelConnection = { ...record(), keySaved: true, models: [{ id: 'm', contextWindow: 1_000_000, contextLengths: [262_144, 1_000_000], defaultContextLength: 262_144 }] };
  state.probe = { endpoints: connection.endpoints, models: [], failures: [] };
  render(<CustomModelDialog machine={null} connection={connection} modelId="m" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-maxContext')).toHaveValue('1M');
  await expect.element(page.getByTestId('custom-model-contextWindow')).toHaveValue('1M');
  await userEvent.click(page.getByRole('button', { name: '600K', exact: true }));
  await expect.element(page.getByTestId('custom-model-maxContext')).toHaveValue('600K');
  await expect.element(page.getByRole('button', { name: '600K', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.clear(page.getByTestId('custom-model-maxContext'));
  expect(document.querySelectorAll('.gg-model-limit-presets button[aria-pressed="true"]')).toHaveLength(0);
  await userEvent.fill(page.getByTestId('custom-model-maxContext'), '2M');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await expect.element(page.getByRole('alert')).toHaveTextContent('Max context cannot be larger than the input limit.');
  await userEvent.fill(page.getByTestId('custom-model-maxContext'), '450k');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved?.models[0]).toMatchObject({ contextWindow: 1_000_000, contextLengths: [300_000, 450_000], defaultContextLength: 300_000 });
});

it('an empty max context saves no lengths, and a typo is refused instead of saved', async () => {
  const connection: CustomModelConnection = { ...record(), keySaved: true, models: [{ id: 'm' }] };
  state.probe = { endpoints: connection.endpoints, models: [], failures: [] };
  render(<CustomModelDialog machine={null} connection={connection} modelId="m" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-maxContext')).toHaveValue('');
  expect(document.querySelectorAll('.gg-model-limit-presets button[aria-pressed="true"]')).toHaveLength(0);
  await userEvent.fill(page.getByTestId('custom-model-maxContext'), '3oo k');
  await userEvent.click(page.getByTestId('custom-model-save'));
  await expect.element(page.getByRole('alert')).toHaveTextContent('Enter a number of tokens such as 300K or 1M');
  await userEvent.clear(page.getByTestId('custom-model-maxContext'));
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved', () => state.saved !== null);
  expect(state.saved?.models[0]?.contextLengths).toBeUndefined();
  expect(state.saved?.models[0]?.contextWindow).toBeUndefined();
});

it('shows a Codex model_context_window as the max context and says where it came from', async () => {
  const connection: CustomModelConnection = { ...record(), keySaved: true, discovered: { source: 'codex-provider', keyLast4: 'WXYZ' }, models: [{ id: 'm', contextWindow: 400_000 }] };
  state.probe = { endpoints: connection.endpoints, models: [], failures: [] };
  render(<CustomModelDialog machine={null} connection={connection} modelId="m" onClose={() => {}} />);
  await expect.element(page.getByTestId('custom-model-maxContext')).toHaveValue('400K');
  await expect.element(page.getByText('From your Codex config', { exact: true })).toBeVisible();
});

it('labels the largest menu length Max, and a model with one length offers no switch', async () => {
  const codex = { id: 'codex', name: 'Codex', capabilities: { modelProtocols: ['openai-responses' as const], customModel: undefined } };
  const connection: CustomModelConnection = { ...record(), keySaved: true, models: [
    { id: 'big', contextWindow: 1_000_000, contextLengths: [300_000, 600_000, 900_000, 1_000_000], defaultContextLength: 300_000 },
    { id: 'plain' },
  ] };
  const options = customComposerOptions([connection], codex, translateSessionMessage);
  render(<div style={{ position: 'fixed', right: 24, bottom: 24, width: 640 }}><ChatComposer modelOptions={options} selectedModel={Object.keys(options)[0]}
    agentOptions={[{ id: 'codex', name: 'Codex' }]} selectedAgent="codex" onModelChange={() => {}} onSubmit={() => {}} onStop={() => {}}
    contextThresholds={(_id, maximum) => maximum ? { minimum: 8_000, maximum, value: null, selectWindow: async () => {} } : undefined} /></div>);
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  const row = (name: string) => [...document.querySelectorAll('[data-slot=composer-model-name]')].find(e => e.textContent?.trim() === name)!.closest('[role=option]') as HTMLElement;
  await until('the menu lists both', () => !!document.querySelector('[data-slot=combobox-content] [role=option]') && !!row('plain'));
  await userEvent.hover(row('plain'));
  await until('the plain detail', () => document.querySelector('[data-slot=composer-model-detail]')?.textContent?.includes('plain') ?? false);
  expect(document.querySelector('[data-slot=composer-model-detail]')?.textContent).not.toContain('Context window');
  await userEvent.hover(row('big'));
  await until('the big detail', () => document.querySelector('[data-slot=composer-model-detail]')?.textContent?.includes('Context window') ?? false);
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('[data-slot=composer-model-detail] button')].find(button => button.textContent?.includes('Context window'))!;
  expect(trigger.textContent).toContain('300K');
  await userEvent.click(trigger);
  await until('the lengths open', () => [...document.querySelectorAll('button')].some(button => button.textContent === 'Max (1M)'));
  expect([...document.querySelectorAll('button[aria-pressed]')].map(button => button.textContent).filter(text => /K|M\)/.test(text ?? ''))).toEqual(['300K', '600K', '900K', 'Max (1M)']);
});
// owner 2026-11-27 02:10: "an error means something is wrong, but it must not stop the person saving". api.777358.xyz listed
// gemini-4-neon and answered 404 model_not_found for it: the save said "cannot reach this address" and kept nothing.
it('owner 11-27: a relay that does not offer the model is saved at the path that said so, closing without a prompt', async () => {
  setLocalePreference('zh-CN');
  const unserved = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://relay.test/v1' };
  state.probe = { endpoints: [], models: ['gemini-2.5-flash', 'gemini-4-neon'], unserved: [unserved], failures: [{ step: 'openai-chat-completions', reason: 'model-not-found' }] };
  const closed = vi.fn();
  render(<CustomModelDialog machine={null} group="custom" onClose={closed} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'gemini-4-neon');
  await until('the address is probed', () => state.probes.length > 0);
  await userEvent.click(page.getByTestId('custom-model-save'));
  await until('the form saved and closed', () => state.saved !== null && closed.mock.calls.length === 1);
  expect(state.saved).toMatchObject({ endpoints: [unserved], unverified: true, unverifiedReason: { reason: 'model-not-found', modelId: 'gemini-4-neon' }, apiKey: 'sk-test', models: [{ id: 'gemini-4-neon' }] });
  expect(state.toasts).toEqual([]);
});
it('owner 11-27: an unverified connection is listed like any other, with no mark', async () => {
  setLocalePreference('zh-CN');
  state.rows = [{ ...record(), keySaved: true, unverified: true, unverifiedReason: { reason: 'model-not-found', modelId: 'gemini-4-neon' }, models: [{ id: 'gemini-4-neon' }] }];
  render(<Sheet ariaLabel="Settings" zIndex="var(--z-settings)" onClose={() => {}}><CustomModelsGroup /></Sheet>);
  await expect.element(page.getByText('Existing provider')).toBeVisible();
  expect(document.body.textContent).not.toMatch(/未验证|中转不提供/);
});
it('Test connection says a relay does not offer the named model instead of that it connected', async () => {
  state.probe = { endpoints: [], models: ['other', 'm'], unserved: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], failures: [{ step: 'openai-chat-completions', reason: 'model-not-found' }] };
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-test');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'm');
  await userEvent.click(page.getByTestId('custom-model-test'));
  await expect.element(page.getByTestId('custom-model-test-result')).toHaveTextContent('The relay does not offer m.');
});
// owner 2026-11-27 02:28: on a long form the refusal sat at its bottom, out of view, in English; the button only flickered.
it('a save the settings process refuses is said beside Save, translated, with the next step, on the longest form', async () => {
  await page.viewport(1000, 640);
  setLocalePreference('zh-CN');
  state.probe = { endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' }], models: ['m'], failures: [] };
  state.saveError = 'Add a new connection to change this API address. Existing sessions still use this address.';
  render(<CustomModelDialog machine={null} group="custom" onClose={() => {}} />);
  await userEvent.fill(page.getByTestId('custom-model-address-0'), 'https://relay.test/v1');
  await userEvent.fill(page.getByTestId('custom-model-key'), 'sk-other');
  await userEvent.fill(page.getByTestId('custom-model-name'), 'm');
  await until('the address is probed', () => state.probes.length > 0);
  await userEvent.click(page.getByTestId('custom-model-advanced'));
  await userEvent.click(page.getByTestId('custom-model-image'));
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) await userEvent.click(page.getByTestId(`custom-model-effort-${level}`));
  expect(dialogBody().scrollHeight).toBeGreaterThan(dialogBody().clientHeight);
  await userEvent.click(page.getByTestId('custom-model-save'));
  const failure = page.getByTestId('custom-model-save-failure');
  await expect.element(failure).toHaveTextContent('还有会话在用这个地址，请新加一条配置。');
  expect(failure.element().closest('.gg-model-dialog-footer')).toBe(page.getByTestId('custom-model-save').element().parentElement);
  const box = failure.element().getBoundingClientRect();
  expect(box.top >= 0 && box.bottom <= window.innerHeight).toBe(true);
  expect(state.saved).toBeNull();
});
