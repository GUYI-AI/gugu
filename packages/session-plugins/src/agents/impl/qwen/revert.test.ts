import { describe, expect, it, vi } from 'vitest';
import { qwenRevert } from './revert';

describe('qwen rewind hook (#2970)', () => {
  it('names the newest rewind snapshot once, and keeps files unless asked', async () => {
    const extMethod = vi.fn(async (method: string) => method === 'qwen/status/session/rewind_snapshots'
      ? { snapshots: [{ promptId: 's########1', turnIndex: 0 }, { promptId: 's########2', turnIndex: 1 }] } : { success: true, filesFailed: [] });
    const agent = { extMethod } as never;
    expect(await qwenRevert.anchorAfterTurn(agent, 's-a', {})).toEqual({ before: 's########2', files: true });
    // A turn that made no snapshot of its own (the newest is still the last one handed out) gets no point.
    expect(await qwenRevert.anchorAfterTurn(agent, 's-a', {})).toBeNull();
    await qwenRevert.revert(agent, { sessionId: 's-a', before: 's########2', files: 'keep' });
    expect(extMethod).toHaveBeenLastCalledWith('qwen/control/session/rewind', { sessionId: 's-a', promptId: 's########2', rewindFiles: false });
    await qwenRevert.revert(agent, { sessionId: 's-a', before: 's########1', files: 'restore' });
    expect(extMethod).toHaveBeenLastCalledWith('qwen/control/session/rewind', { sessionId: 's-a', promptId: 's########1', rewindFiles: true });
  });

  it('a rewind that did not happen, or a file it could not restore, is a failure', async () => {
    await expect(qwenRevert.revert({ extMethod: vi.fn(async () => ({ success: false })) } as never,
      { sessionId: 's-c', before: 'p', files: 'keep' })).rejects.toThrow('did not rewind');
    await expect(qwenRevert.revert({ extMethod: vi.fn(async () => ({ success: true, filesFailed: ['/w/a.txt'] })) } as never,
      { sessionId: 's-c', before: 'p', files: 'restore' })).rejects.toThrow('/w/a.txt');
  });

  it('fails loudly on an answer without snapshots', async () => {
    const agent = { extMethod: vi.fn(async () => ({})) } as never;
    await expect(qwenRevert.anchorAfterTurn(agent, 's-b', {})).rejects.toThrow('without snapshots');
  });
});
