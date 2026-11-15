import { QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A workspace image is a replica entry (was an effect per <img> with its own loading state): one read per file, read
// again when the machine says that file changed, null = not there (❌ an error).
const mocks = vi.hoisted(() => ({ readImage: vi.fn(), feed: null as null | ((event: unknown) => void) }));
vi.mock('./workspace-backend', () => ({
  workspaceRpc: () => ({ files: { readImage: mocks.readImage } }),
  workspaceEvents: { on: (_event: unknown, cb: (event: unknown) => void) => { mocks.feed = cb; return () => { mocks.feed = null; }; } },
}));

const { followRendererSession, queryClient } = await import('@/lib/replica');
const { watchWorkspaceImages, workspaceImage } = await import('./workspace-image');

beforeEach(() => {
  queryClient.clear();
  mocks.readImage.mockReset();
  followRendererSession('SIGNED_IN', 'tester');
});

describe('workspace images', () => {
  it('a missing file is null, a failed read is an error', async () => {
    mocks.readImage.mockResolvedValueOnce({ success: true, data: { success: false } });
    await expect(workspaceImage.fetch('p', 'w', 'gone.png')).resolves.toBeNull();
    mocks.readImage.mockResolvedValueOnce({ success: false, error: 'boom' });
    await workspaceImage.prefetch('p', 'w', 'bad.png');
    expect(workspaceImage.peek('p', 'w', 'bad.png').state).toBe('error');
  });

  it('the file feed reads a changed image again, and only that one', async () => {
    mocks.readImage.mockImplementation(async (_p, _w, path: string) => ({ success: true, data: { success: true, dataUrl: `data:${path}:${mocks.readImage.mock.calls.length}` } }));
    const stop = watchWorkspaceImages();
    await workspaceImage.fetch('p', 'w', 'a.png');
    await workspaceImage.fetch('p', 'w', 'b.png');
    // Keep both shown (an observer each) so a refresh reads them again.
    const offs = ['a.png', 'b.png'].map((path) =>
      new QueryObserver(queryClient, workspaceImage.options(workspaceImage.key('p', 'w', path)!) as never).subscribe(() => {}));
    mocks.feed!({ workspaceId: 'w', update: { kind: 'changes', changes: [{ path: 'a.png' }] } });
    await vi.waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(3));
    expect(mocks.readImage.mock.calls[2]![2]).toBe('a.png');
    offs.forEach((off) => off());
    stop();
    expect(mocks.feed).toBeNull();
  });
});
