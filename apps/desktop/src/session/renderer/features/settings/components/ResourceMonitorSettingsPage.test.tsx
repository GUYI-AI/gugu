// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../../tests/support/testHarness';
import { ResourceMonitorSettingsPage } from './ResourceMonitorSettingsPage';

const rig = vi.hoisted(() => ({ enabled: false, update: vi.fn(), invoke: vi.fn() }));
vi.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ settings: { state: 'value', value: { value: { enabled: rig.enabled, pageCounters: true } } }, update: rig.update, isSaving: false }),
}));
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: rig.invoke, eventOn: () => () => undefined }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { resourceMonitor: { watch: () => () => undefined, setInternals: async () => undefined } } }));
vi.mock('./resource-timeline', () => ({ ResourceTimeline: () => null }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  harness = createReactHarness();
  rig.update.mockReset();
  rig.invoke.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => harness.cleanup());

const toggle = async () => {
  const button = harness.container.querySelector<HTMLElement>('[aria-label="resourceMonitor.enabled"]')!;
  await act(async () => { button.click(); });
};

it('says so when the grant could not be made', async () => {
  rig.enabled = false;
  rig.invoke.mockResolvedValue({ ok: false, code: 'unsupported', message: 'nope' });
  await harness.render(<ResourceMonitorSettingsPage />);
  await toggle();
  expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('resourceMonitor.grantFailed');
});
