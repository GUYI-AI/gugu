// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '@shared/core/automations/automation';

const io = vi.hoisted(() => ({ navigate: vi.fn(), toggle: vi.fn() }));
vi.mock('../automations-host', () => ({ useAutomationsHost: () => ({ remote: { deviceId: 'd22', deviceLabel: 'Linux', online: true } }) }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { cloudScope: () => null } }));
vi.mock('@renderer/features/remote-hosts/device-scope-picker', () => ({ DeviceScopeNoticeLine: () => null }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: io.navigate }),
  useParams: () => ({ params: {}, setParams: vi.fn() }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('./AutomationDetailView', () => ({ AutomationDetailView: () => null }));
vi.mock('./AutomationsList', () => ({
  AutomationsList: ({ automations, onEdit, onToggleEnabled }: {
    automations: Automation[];
    onEdit: (automation: Automation) => void;
    onToggleEnabled: (automation: Automation, enabled: boolean) => void;
  }) => automations.map((automation) => (
    <div key={automation.id}>
      <button type="button" onClick={() => onEdit(automation)}>{automation.name}</button>
      <button type="button" onClick={() => onToggleEnabled(automation, !automation.enabled)}>Toggle {automation.name}</button>
    </div>
  )),
}));
vi.mock('../use-automations', () => ({
  useAutomations: () => ({
    automations: {
      state: 'value',
      value: [
        { id: 'daily', name: 'Daily digest', enabled: true },
        { id: 'paused', name: 'Weekly digest', enabled: false },
        { id: 'ended', name: 'One-time report', enabled: false, triggerConfig: { at: 1 } },
      ],
    },
    toggleEnabled: { mutate: io.toggle },
  }),
}));

import { AutomationDeviceGroup } from './AutomationDeviceGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(container: ParentNode, label: string) {
  const match = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe('automation device groups', () => {
  it('opens each device by default and collapses device and inactive sections independently', () => {
    act(() => root.render(<><AutomationDeviceGroup label="Linux" search="" /><AutomationDeviceGroup label="Mac" search="" /></>));
    const [linux, mac] = Array.from(container.querySelectorAll('section'));
    const linuxHeading = button(linux, 'Linux');
    const inactiveHeading = button(linux, 'automations.inactiveGroup2');
    expect(linuxHeading.getAttribute('aria-expanded')).toBe('true');
    expect(inactiveHeading.getAttribute('aria-expanded')).toBe('false');
    expect(button(linux, 'Daily digest').closest('[hidden]')).toBeNull();
    expect(button(linux, 'Weekly digest').closest('[hidden]')).not.toBeNull();
    expect(button(linux, 'One-time report').closest('[hidden]')).not.toBeNull();
    act(() => inactiveHeading.click());
    expect(inactiveHeading.getAttribute('aria-expanded')).toBe('true');
    expect(button(mac, 'automations.inactiveGroup2').getAttribute('aria-expanded')).toBe('false');
    act(() => linuxHeading.click());
    expect(linuxHeading.getAttribute('aria-expanded')).toBe('false');
    expect(button(mac, 'Mac').getAttribute('aria-expanded')).toBe('true');
  });

  it('filters within the group and opens details with the owning device ID', () => {
    act(() => root.render(<AutomationDeviceGroup label="Linux" search=" daily " />));
    expect(container.textContent).not.toContain('Weekly digest');
    act(() => button(container, 'Daily digest').click());
    expect(io.navigate).toHaveBeenCalledWith('automations', { automationId: 'daily', automationDeviceId: 'd22' });
    act(() => button(container, 'Toggle Daily digest').click());
    expect(io.toggle).toHaveBeenCalledWith({ id: 'daily', enabled: false });
  });
});
