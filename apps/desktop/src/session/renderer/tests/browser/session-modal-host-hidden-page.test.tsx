/**
 * #3366: on desktop the task page stays mounted but hidden while contacts (or another page) is on screen. A session
 * dialog asked for from there must show on screen and still be drawn inside the task page's tree: some dialogs need its
 * providers (integrationSetupModal throws outside IntegrationsProvider). SessionModalHost is rendered by the task page's
 * App; it portals to <body>. The probe below stands for such a dialog: it throws outside the task page's provider.
 */
import { Component, createContext, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SessionModalHost } from '@/components/SessionModalHost';
import { modalStore } from '@renderer/lib/modal/modal-store';
import '@/styles/tokens.css';
import '@renderer/index.css';

const TaskPageOnly = createContext<string | null>(null);
function ProbeModal() {
  const value = useContext(TaskPageOnly);
  if (!value) throw new Error('drawn outside the task page tree');
  return <p data-probe>{value}</p>;
}
vi.mock('@renderer/app/modal-registry', async (original) => {
  const actual = await original<typeof import('@renderer/app/modal-registry')>();
  const { createModal } = await import('@/components/ui/modal-registry');
  return { ...actual, modalRegistry: { ...actual.modalRegistry, probeModal: createModal(ProbeModal, { size: 'xs' }) } };
});

class Catch extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  modalStore.closeModal();
});
afterEach(() => {
  modalStore.closeModal();
  root.unmount();
  host.remove();
});

const openProbe = () => modalStore.setModal('probeModal' as never, { onClose: () => modalStore.closeModal('dismissed') } as never);
const probe = () => document.querySelector<HTMLElement>('[data-probe]');

it('a dialog asked for while the task page is hidden shows on screen, drawn in the task page tree', async () => {
  root.render(
    <TaskPageOnly.Provider value="task page providers">
      <div data-hidden-task-page style={{ display: 'none' }}><SessionModalHost /></div>
    </TaskPageOnly.Provider>
  );
  openProbe();
  await until('the probe dialog is drawn', () => probe() !== null);
  expect(probe()!.textContent).toBe('task page providers');
  expect(probe()!.closest('[data-hidden-task-page]'), 'not inside the hidden page').toBeNull();
  expect(probe()!.checkVisibility(), 'on screen').toBe(true);
});

// Control: the same probe drawn by a host outside the task page tree (the shell drawing it, as a second host would)
// throws, so the case above passing means the provider really reached it.
it('the probe needs the task page tree: drawn outside it, it throws', async () => {
  const errors: Error[] = [];
  root.render(<Catch onError={(error) => errors.push(error)}><SessionModalHost /></Catch>);
  openProbe();
  await until('the probe failed to draw', () => errors.length > 0);
  expect(errors[0].message).toBe('drawn outside the task page tree');
});
