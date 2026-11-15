// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  machine: null as string | null,
  state: 'connected' as string,
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => fixture.machine } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    device: (id: string) => ({ id, label: '测试机B', isOnline: fixture.state !== 'offline', lastSeenAt: null }),
    connectionState: () => fixture.state,
  },
}));
vi.mock('../session-view-context', () => ({ useSessionViewContext: () => ({ projectId: 'p1', sessionId: 's1' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n/format', () => ({ formatRelativeTime: () => '2 分钟前' }));

import { ColdSessionStrip, SessionMachineStatus } from './session-machine-status';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('says the remote machine and its state, nothing for this computer', () => {
  fixture.machine = null;
  act(() => root.render(<SessionMachineStatus />));
  expect(container.querySelector('[data-testid="session-machine-status"]')).toBeNull();

  fixture.machine = 'dev-b';
  fixture.state = 'reconnecting';
  act(() => root.render(<SessionMachineStatus key="remote" />));
  const status = container.querySelector('[data-testid="session-machine-status"]');
  expect(status?.getAttribute('data-state')).toBe('connecting');
  expect(status?.textContent).toContain('测试机B');
});

it('gives a cold remote block the strip, and leaves a cold local block as it was', () => {
  fixture.machine = null;
  act(() => root.render(<ColdSessionStrip><p>cold</p></ColdSessionStrip>));
  expect(container.querySelector('[data-slot="cold-session-strip"]')).toBeNull();
  expect(container.textContent).toBe('cold');

  fixture.machine = 'dev-b';
  fixture.state = 'offline';
  act(() => root.render(<ColdSessionStrip key="remote"><p>cold</p></ColdSessionStrip>));
  expect(container.querySelector('[data-slot="cold-session-strip"] [data-testid="session-machine-status"]')?.getAttribute('data-state')).toBe('device_offline');
});
