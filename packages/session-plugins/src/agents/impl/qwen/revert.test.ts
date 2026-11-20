import { describe, expect, it, vi } from 'vitest';
import { qwenRevert } from './revert';

describe('qwen revert hook', () => {
  it('names the newest rewind snapshot, and keeps files unless asked', async () => {
    const extMethod = vi.fn(async (method: string) => method === 'qwen/status/session/rewind_snapshots'
      ? { snapshots: [{ promptId: 's########1', turnIndex: 0 }, { promptId: 's########2', turnIndex: 1 }] } : { success: true, filesFailed: [] });
    const agent = { extMethod } as never;
    expect(await qwenRevert.point(agent, 's-a', {})).toEqual({ before: 's########2', files: true });
    await qwenRevert.revert(agent, 's-a', 's########2', false);
    expect(extMethod).toHaveBeenLastCalledWith('qwen/control/session/rewind', { sessionId: 's-a', promptId: 's########2', rewindFiles: false });
    await qwenRevert.revert(agent, 's-a', 's########1', true);
    expect(extMethod).toHaveBeenLastCalledWith('qwen/control/session/rewind', { sessionId: 's-a', promptId: 's########1', rewindFiles: true });
  });

  it('a rewind that did not happen, or a file it could not restore, is a failure', async () => {
    await expect(qwenRevert.revert({ extMethod: vi.fn(async () => ({ success: false })) } as never, 's-c', 'p', false))
      .rejects.toThrow('did not rewind');
    await expect(qwenRevert.revert({ extMethod: vi.fn(async () => ({ success: true, filesFailed: ['/w/a.txt'] })) } as never, 's-c', 'p', true))
      .rejects.toThrow('/w/a.txt');
  });

  it('fails loudly on an answer without snapshots', async () => {
    const agent = { extMethod: vi.fn(async () => ({})) } as never;
    await expect(qwenRevert.point(agent, 's-b', {})).rejects.toThrow('without snapshots');
  });
});
