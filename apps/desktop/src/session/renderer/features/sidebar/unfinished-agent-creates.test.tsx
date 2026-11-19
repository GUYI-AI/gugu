// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishSelfIdentity } from '@/lib/selfIdentityBridge';
import { publishUnfinishedAgentCreates } from '@/lib/unfinishedAgentCreateBridge';
import { UnfinishedAgentCreates } from './unfinished-agent-creates';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => confirm }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  publishUnfinishedAgentCreates(null);
  publishSelfIdentity(null);
  confirm.mockReset();
});
async function mount(collapsed = false, busy = false) {
  publishSelfIdentity({ userId: 'owner', displayName: null, guguNumber: null });
  const run = vi.fn();
  publishUnfinishedAgentCreates({ ownerUserId: 'owner', rows: [{ operationId: 'op', name: '资料整理助手' }], busy, run });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<UnfinishedAgentCreates collapsed={collapsed} />));
  return run;
}
describe('approved unfinished creation row', () => {
  it('shows the real name and two text actions; Continue runs only on click', async () => {
    const run = await mount();
    expect(container.textContent).toContain('资料整理助手');
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    await act(async () => buttons[0].click());
    expect(run).toHaveBeenCalledExactlyOnceWith('op', 'continue');
  });
  it('Delete opens the existing confirmation and does no work until confirmed', async () => {
    const run = await mount();
    await act(async () => container.querySelectorAll('button')[1].click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    confirm.mock.calls[0][0].onSuccess();
    expect(run).toHaveBeenCalledExactlyOnceWith('op', 'delete');
  });
  it('account change hides the row and invalidates an earlier confirmation', async () => {
    const run = await mount();
    await act(async () => container.querySelectorAll('button')[1].click());
    await act(async () => publishSelfIdentity({ userId: 'another', displayName: null, guguNumber: null }));
    expect(container.textContent).toBe('');
    confirm.mock.calls[0][0].onSuccess();
    expect(run).not.toHaveBeenCalled();
  });
  it('collapsed sidebar hides it; in-flight actions are disabled', async () => {
    await mount(true);
    expect(container.textContent).toBe('');
    await act(async () => root.render(<UnfinishedAgentCreates collapsed={false} />));
    await act(async () => publishUnfinishedAgentCreates({ ownerUserId: 'owner', rows: [{ operationId: 'op', name: '资料整理助手' }], busy: true, run: vi.fn() }));
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
  });
});
