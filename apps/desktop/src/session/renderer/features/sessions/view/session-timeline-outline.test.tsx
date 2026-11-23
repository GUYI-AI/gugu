// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionOutline, SessionOutlineTurn } from '@shared/core/sessions/session-outline';

const mocks = vi.hoisted(() => ({ getOutline: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessions: { getOutline: mocks.getOutline } } }));
const { resetOutlines, useOutline } = await import('./session-timeline-outline');

const turn = (id: string): SessionOutlineTurn => ({ id, inputs: [] });
const turns = (...ids: string[]) => ids.map(turn);
let seen: readonly SessionOutlineTurn[] = [];
function Probe({ oldest }: { oldest: string }) {
  seen = useOutline('s1', oldest, true);
  return null;
}
let root: Root;
const show = (oldest: string) => act(async () => root.render(<Probe oldest={oldest} />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.getOutline.mockReset();
  resetOutlines();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

// On a long conversation the whole outline is a megabyte; reading the newest page anew moves where the loaded history
// starts, and asking for the whole outline again each time filled a slow link for seconds.
describe('the outline when the loaded history moves on', () => {
  it('asks only for the stretch after the newest outlined turn, and adds it to what is held', async () => {
    mocks.getOutline.mockResolvedValueOnce({ turns: turns('t0', 't1', 't2') } satisfies SessionOutline);
    await show('t3');
    expect(mocks.getOutline).toHaveBeenLastCalledWith({ sessionId: 's1', beforeTurnId: 't3' });
    mocks.getOutline.mockResolvedValueOnce({ turns: turns('t3', 't4'), after: 't2' } satisfies SessionOutline);
    await show('t5');
    expect(mocks.getOutline).toHaveBeenLastCalledWith({ sessionId: 's1', beforeTurnId: 't5', afterTurnId: 't2' });
    expect(seen.map((one) => one.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('takes a whole answer (a machine that does not know afterTurnId) in place of what is held, without doubles', async () => {
    mocks.getOutline.mockResolvedValueOnce({ turns: turns('t0', 't1', 't2') });
    await show('t3');
    mocks.getOutline.mockResolvedValueOnce({ turns: turns('t0', 't1', 't2', 't3', 't4') });
    await show('t5');
    expect(seen.map((one) => one.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('asks once while a question is on its way; an older page landing meanwhile is covered by the answer', async () => {
    let answer!: (outline: SessionOutline) => void;
    mocks.getOutline.mockReturnValueOnce(new Promise<SessionOutline>((resolve) => { answer = resolve; }));
    await show('t3');
    await show('t1');
    expect(mocks.getOutline).toHaveBeenCalledOnce();
    await act(async () => answer({ turns: turns('t0', 't1', 't2') }));
    expect(mocks.getOutline).toHaveBeenCalledOnce();
    expect(seen.map((one) => one.id)).toEqual(['t0', 't1', 't2']);
  });
});
