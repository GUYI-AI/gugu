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
const { workspaceImage } = await import('./workspace-image');

/** A surface showing these images (an observer each): it opens the file feed while shown. */
const show = (...paths: string[]) => paths.map((path) =>
  new QueryObserver(queryClient, workspaceImage.options(workspaceImage.key('p', 'w', path)!) as never).subscribe(() => {}));

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

  it('the file feed reads a changed image again, and only that one, while an image is shown', async () => {
    mocks.readImage.mockImplementation(async (_p, _w, path: string) => ({ success: true, data: { success: true, dataUrl: `data:${path}:${mocks.readImage.mock.calls.length}` } }));
    await workspaceImage.fetch('p', 'w', 'a.png');
    await workspaceImage.fetch('p', 'w', 'b.png');
    expect(mocks.feed).toBeNull();
    const offs = show('a.png', 'b.png');
    // Opening the feed reads again what is held (changes made while nobody listened).
    await vi.waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(4));
    mocks.feed!({ workspaceId: 'w', update: { kind: 'changes', changes: [{ path: 'a.png' }] } });
    await vi.waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(5));
    expect(mocks.readImage.mock.calls[4]![2]).toBe('a.png');
    offs.forEach((off) => off());
    expect(mocks.feed).toBeNull();
  });

  it('an image shown again within its minute is read again (the file may have changed meanwhile)', async () => {
    mocks.readImage.mockResolvedValueOnce({ success: true, data: { success: true, dataUrl: 'data:old' } })
      .mockResolvedValueOnce({ success: true, data: { success: true, dataUrl: 'data:new' } });
    const [first] = show('a.png');
    await vi.waitFor(() => expect(workspaceImage.peek('p', 'w', 'a.png')).toMatchObject({ value: 'data:old' }));
    first!();
    const [again] = show('a.png');
    await vi.waitFor(() => expect(workspaceImage.peek('p', 'w', 'a.png')).toMatchObject({ value: 'data:new' }));
    again!();
  });
});
