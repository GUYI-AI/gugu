import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissingFileObjectError, type FileHandle } from '@gugu/core/shared/fileResolver';
import { WORKSPACE_STORED_TEXT_MAX_BYTES } from '@gugu/core/shared/workspaceUpload.mjs';
import { createAppFiles, type FilesPlatform } from './app-files-core';
import { bridgeFailure, callRefusal } from './bridge-protocol';

const item = '44444444-4444-4444-8444-444444444444';
const owner = '11111111-1111-4111-8111-111111111111';
const surface = { pageId: 7, extensionId: 'reader', itemId: item };
const ref = { id: item, version: 1 };

function fixture(contentType = 'application/octet-stream', size = 32) {
  let capability = false, account = owner;
  let released: Parameters<NonNullable<FilesPlatform['sync']['onPageRelease']>>[0] | undefined;
  const dispose = vi.fn(async () => undefined);
  const read = vi.fn(async (offset: number, length: number) => Uint8Array.from({ length }, (_, i) => (offset + i) % 251));
  const resolveFile = vi.fn(async (_ref, actor, options) => ({
    status: 'ready', purpose: 'file', reader: { accountId: account, actorId: actor ?? account },
    revision: { source: 'local', item_id: item, version: options.version ?? 1, chat_id: 'group',
      file_name: contentType === 'text/plain' ? 'small.txt' : 'data.sqlite', content_type: contentType,
      size_bytes: size, sha256: 'a'.repeat(64), host_account_id: account,
      workspace: { path: 'data.sqlite', parent_id: null, created_at: null, updated_at: null, created_by: owner, source_message_ids: [] } },
    read, stream: async function* () { yield await read(0, size); }, dispose,
  } as FileHandle));
  const platform: FilesPlatform = {
    resolveFile, account: async () => ({ token: 'synthetic', userId: account }),
    hasCapability: () => capability, identities: async () => [], faces: async () => ({}),
    filesUrl: () => 'https://files.invalid', warn: vi.fn(),
    sync: { ensureFor: () => undefined, pageFor: vi.fn(() => ({}) as never), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn(),
      onPageRelease: (listener) => { released = listener; return () => undefined; } },
  };
  const files = createAppFiles(platform);
  return { files, read, dispose, resolveFile, platform,
    capability: (value: boolean) => { capability = value; }, account: (value: string) => { account = value; },
    // The page went away (its tab torn down) vs. the page lost access (revoked: a grant filter, all of it here).
    release: (pageId = surface.pageId) => released?.(pageId), revoke: (pageId = surface.pageId) => released?.(pageId, () => true) };
}

afterEach(() => vi.useRealTimers());

describe('chat stored files reuse verified, pinned range reads', () => {
  it('opens a binary file without acquiring or returning its bytes', async () => {
    const f = fixture();
    expect(await f.files.open(surface, { ref: { id: item } })).toMatchObject({ chunked: true, entry: { size: 32, version: 1 } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('opens text an editor can hold whole, and chunks larger text without a byte read', async () => {
    const small = fixture('text/plain');
    expect(await small.files.open(surface, { ref: { id: item } })).toHaveProperty('bytes');
    const large = fixture('text/plain', WORKSPACE_STORED_TEXT_MAX_BYTES + 1);
    expect(await large.files.open(surface, { ref: { id: item } })).toMatchObject({ chunked: true });
    expect(large.read).not.toHaveBeenCalled();
  });
  it('reads exact first/middle/tail ranges and reuses one pinned handle', async () => {
    const f = fixture();
    for (const offset of [0, 12, 28]) {
      const answer = await f.files.read(surface, { ref, offset, length: 4 });
      expect(answer).toMatchObject({ size: 32, offset });
      expect(answer.data).toBeInstanceOf(Uint8Array);
      expect([...answer.data]).toEqual([offset, offset + 1, offset + 2, offset + 3]);
    }
    expect(f.resolveFile).toHaveBeenCalledTimes(1);
    expect(f.resolveFile).toHaveBeenCalledWith(expect.anything(), null, expect.objectContaining({ version: 1 }));
    await f.files.close(surface, { ref });
  });
  it('rejects oversized/invalid ranges and an unpinned version', async () => {
    const f = fixture();
    for (const range of [{ offset: -1, length: 2 }, { offset: 0.5, length: 2 }, { offset: 0, length: 524289 }]) {
      await expect(f.files.read(surface, { ref, ...range })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(f.files.read(surface, { ref: { id: item } as never, offset: 0, length: 2 })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 8191, 8192, 8193, 524288])('serializes only the returned binary view for a %i-byte range', async length => {
    const f = fixture('application/octet-stream', length);
    const backing = new Uint8Array(length + 16).fill(255);
    const bytes = backing.subarray(7, 7 + length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    f.read.mockResolvedValueOnce(bytes);
    const result = await f.files.read(surface, { ref, offset: 0, length });
    const delivered = structuredClone(result).data;
    expect(delivered).toBeInstanceOf(Uint8Array);
    expect(delivered).toEqual(bytes);
    expect(delivered.byteOffset).toBe(0);
    expect(delivered.buffer.byteLength).toBe(length);
    expect(new Uint8Array(delivered.buffer)).toEqual(bytes);
    await f.files.close(surface, { ref });
  });
  it('does not grant an unbound page or another file through the capability-free bridge verb', async () => {
    const f = fixture();
    expect(callRefusal('filesRead', { ref }, { kind: 'page', has: () => false, gesture: false, widget: false })).toBe(null);
    await expect(f.files.read({ ...surface, itemId: null }, { ref, offset: 0, length: 2 })).rejects.toMatchObject({ code: 'denied' });
    await expect(f.files.read({ ...surface, itemId: 'another' }, { ref, offset: 0, length: 2 })).rejects.toMatchObject({ code: 'denied' });
    expect(f.read).not.toHaveBeenCalled();
    f.capability(true);
    await expect(f.files.read({ ...surface, itemId: null }, { ref, offset: 0, length: 2 })).resolves.toMatchObject({ size: 32 });
  });
  it('rechecks a cached grant after the binding is removed', async () => {
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 2 });
    await expect(f.files.read({ ...surface, itemId: null }, { ref, offset: 2, length: 2 })).rejects.toMatchObject({ code: 'denied' });
  });
  it('never substitutes a newer revision for the requested old version', async () => {
    const f = fixture(), original = f.resolveFile.getMockImplementation()!;
    f.resolveFile.mockImplementation(async (...args) => {
      const handle = await original(...args); handle.revision.version = 2; return handle;
    });
    await expect(f.files.read(surface, { ref, offset: 0, length: 2 })).rejects.toMatchObject({ code: 'stale-version' });
    expect(f.read).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalled();
  });
  it('reports a physically missing pinned object as stale-version', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new MissingFileObjectError());
    const error = await f.files.read(surface, { ref, offset: 0, length: 2 }).catch(error => error);
    expect(bridgeFailure(error)).toMatchObject({ code: 'stale-version', message: expect.stringContaining('version') });
  });
  it('releases range handles on close, page revocation, and five idle minutes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 2 });
    await f.files.close(surface, { ref });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await f.files.read(surface, { ref, offset: 0, length: 2 }); f.revoke();
    await Promise.resolve(); expect(f.dispose).toHaveBeenCalledTimes(2);
    await f.files.read(surface, { ref, offset: 0, length: 2 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.dispose).toHaveBeenCalledTimes(3);
  });
  it('one of two opens cannot close the other range reader', async () => {
    const f = fixture();
    await f.files.open(surface, { ref: { id: item } });
    await f.files.open(surface, { ref: { id: item } });
    const disposedMetadata = f.dispose.mock.calls.length;
    await f.files.close(surface, { ref }); expect(f.dispose).toHaveBeenCalledTimes(disposedMetadata);
    await expect(f.files.read(surface, { ref, offset: 0, length: 2 })).resolves.toMatchObject({ size: 32 });
    await f.files.close(surface, { ref }); expect(f.dispose).toHaveBeenCalledTimes(disposedMetadata + 1);
    expect(f.files.readHandleCount()).toBe(0);
  });
  it('another actor reading the same file and version preserves an in-flight read', async () => {
    const f = fixture();
    const first = { ...surface, asAgent: '55555555-5555-4555-8555-555555555555' };
    const second = { ...surface, asAgent: '66666666-6666-4666-8666-666666666666' };
    await f.files.open(first, { ref: { id: item } });
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    f.read.mockImplementationOnce(() => { started.resolve(); return answer.promise; });
    const reading = f.files.read(first, { ref, offset: 0, length: 2 })
      .then(value => ({ value }), error => ({ error }));
    await started.promise;
    await f.files.open(second, { ref: { id: item } });
    const other = await f.files.read(second, { ref, offset: 2, length: 2 });
    await f.files.close(second, { ref });
    answer.resolve(new Uint8Array([1, 2]));
    try {
      expect(await reading).toEqual({ value: { size: 32, offset: 0, data: new Uint8Array([1, 2]) } });
      expect([...other.data]).toEqual([2, 3]);
      expect(f.files.readHandleCount()).toBe(1);
      await f.files.close(first, { ref });
      expect(f.files.readHandleCount()).toBe(0);
    } finally { f.release(); }
  });
  it('closing one actor cannot close another actor reading the same file and version', async () => {
    const f = fixture();
    const first = { ...surface, asAgent: '55555555-5555-4555-8555-555555555555' };
    const second = { ...surface, asAgent: '66666666-6666-4666-8666-666666666666' };
    await f.files.open(first, { ref: { id: item } });
    await f.files.open(second, { ref: { id: item } });
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    f.read.mockImplementationOnce(() => { started.resolve(); return answer.promise; });
    const reading = f.files.read(second, { ref, offset: 2, length: 2 })
      .then(value => ({ value }), error => ({ error }));
    await started.promise;
    await f.files.close(first, { ref });
    answer.resolve(new Uint8Array([3, 4]));
    try {
      expect(await reading).toEqual({ value: { size: 32, offset: 2, data: new Uint8Array([3, 4]) } });
      expect(f.files.readHandleCount()).toBe(1);
      await f.files.close(second, { ref });
      expect(f.files.readHandleCount()).toBe(0);
    } finally { f.release(); }
  });
  it('a page revoked during a pending read never receives its bytes', async () => {
    const f = fixture();
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.files.read(surface, { ref, offset: 0, length: 2 });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    f.revoke(); finish(new Uint8Array([1, 2]));
    await expect(pending).rejects.toMatchObject({ code: 'failed' });
    expect(f.files.readHandleCount()).toBe(0);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('does not count an unfinished range as five idle minutes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    f.read.mockImplementationOnce(() => { started.resolve(); return answer.promise; });
    const pending = f.files.read(surface, { ref, offset: 0, length: 2 });
    await started.promise;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(f.dispose).not.toHaveBeenCalled();
    answer.resolve(new Uint8Array([1, 2])); await pending;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('releases an unpublished local snapshot when its page has disappeared', async () => {
    const f = fixture();
    f.platform.sync.pageFor = () => { throw new Error('This surface is gone'); };
    await expect(f.files.open(surface, { ref: { id: item } })).rejects.toThrow('This surface is gone');
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(f.files.readHandleCount()).toBe(0);
  });
  it('idle expiry reacquires the same version and reports a missing old version', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.files.open(surface, { ref: { id: item } });
    await f.files.read(surface, { ref, offset: 0, length: 2 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    f.resolveFile.mockRejectedValueOnce(new MissingFileObjectError());
    await expect(f.files.read(surface, { ref, offset: 2, length: 2 })).rejects.toMatchObject({ code: 'stale-version' });
    expect(f.resolveFile).toHaveBeenLastCalledWith(expect.anything(), null, expect.objectContaining({ version: 1 }));
  });
  it('rejects bytes retained under the previous signed-in account', async () => {
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 2 });
    f.account('22222222-2222-4222-8222-222222222222');
    await expect(f.files.read(surface, { ref, offset: 2, length: 2 })).rejects.toMatchObject({ code: 'denied' });
  });

  it('a page torn down and mounted again in the same run keeps its one read after one resolve of its own; five idle minutes later it is read once more', async () => {
    vi.useFakeTimers();
    for (const contentType of ['application/octet-stream', 'text/plain']) {
      const f = fixture(contentType);
      await f.files.read(surface, { ref, offset: 0, length: 4 });
      expect(f.resolveFile).toHaveBeenCalledTimes(1);
      f.release();
      const again = { ...surface, pageId: 8 };
      for (const offset of [0, 12, 28]) await f.files.read(again, { ref, offset, length: 4 });
      // One resolve of its own for the new page (a check: its handle is let go unread), then the same held read, chunk after chunk.
      expect(f.resolveFile).toHaveBeenCalledTimes(2);
      expect(f.files.readHandleCount()).toBe(1);
      expect(f.dispose).toHaveBeenCalledTimes(1);
      f.release(8);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(f.files.readHandleCount()).toBe(0);
      await f.files.read({ ...surface, pageId: 9 }, { ref, offset: 0, length: 4 });
      expect(f.resolveFile).toHaveBeenCalledTimes(3);
      expect(f.files.readHandleCount()).toBe(1);
      f.release(9);
    }
  });
  it('access lost while the page was gone: reading again within five minutes is refused and the held read released', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 4 });
    f.release();
    // Removed from the group meanwhile, with no revocation reaching this page: the service now says gone.
    f.resolveFile.mockResolvedValue({ status: 'gone', sha256: null } as never);
    await expect(f.files.read({ ...surface, pageId: 8 }, { ref, offset: 0, length: 4 })).rejects.toMatchObject({ code: 'stale-version' });
    expect(f.files.readHandleCount()).toBe(0);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('a revoked page releases at once, and a read that fails (its acknowledgement refused) is not kept', async () => {
    const f = fixture('text/plain');
    await f.files.open(surface, { ref: { id: item } });
    f.revoke();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledTimes(1));
    f.read.mockRejectedValueOnce(Object.assign(new Error('refused'), { name: 'FileReadRevokedError' }));
    await expect(f.files.open(surface, { ref: { id: item } })).rejects.toThrow('refused');
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledTimes(2));
    const resolves = f.resolveFile.mock.calls.length;
    await f.files.open(surface, { ref: { id: item } });
    expect(f.resolveFile.mock.calls.length).toBeGreaterThan(resolves);
    f.release();
  });
  it('another reader of the same App never takes this reader\'s read', async () => {
    const f = fixture('text/plain');
    await f.files.open(surface, { ref: { id: item } });
    await f.files.open({ ...surface, pageId: 8, asAgent: '22222222-2222-4222-8222-222222222222' }, { ref: { id: item } });
    // The agent acquires its own read, as itself; the person's held read is not handed to it.
    expect(f.resolveFile.mock.calls.some(([, actor]) => actor === '22222222-2222-4222-8222-222222222222')).toBe(true);
    expect(f.files.readHandleCount()).toBe(2);
    f.release(); f.release(8);
  });
  it('a page that goes away takes its check with it: remount after remount, the held read remembers only live pages', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 4 });
    // Pages come and go faster than the idle timer, so the read is never let go; what it keeps per page must go with each page.
    for (let pageId = 8; pageId < 40; pageId++) { await f.files.read({ ...surface, pageId }, { ref, offset: 0, length: 4 }); f.release(pageId); }
    expect(f.files.readHandleCount()).toBe(1);
    f.release();
    // The same page id seen again is a page that has not resolved this version as itself: it resolves once more.
    const resolves = f.resolveFile.mock.calls.length;
    await f.files.read(surface, { ref, offset: 0, length: 4 });
    expect(f.resolveFile.mock.calls.length).toBe(resolves + 1);
    f.release();
  });
  it('a program call registers one abort listener for its read, however many ranges it reads', async () => {
    const f = fixture('application/octet-stream', 4096);
    const call = new AbortController();
    const listen = vi.spyOn(call.signal, 'addEventListener');
    const program = { ...surface, callId: 'call-1', signal: call.signal };
    for (let offset = 0; offset < 4096; offset += 64) await f.files.read(program, { ref, offset, length: 64 });
    expect(listen.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
    call.abort();
    await vi.waitFor(() => expect(f.files.readHandleCount()).toBe(0));
  });
  it('a reader taken out of the chat lets go of what it holds of the chat\'s files at once, page or no page', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.files.read(surface, { ref, offset: 0, length: 4 });
    // The page went away: the read waits for the next page of this reader (#3281) — until the reader leaves the chat.
    f.release();
    await f.files.releaseChat('another-group', null);
    await f.files.releaseChat('group', '22222222-2222-4222-8222-222222222222');
    expect(f.files.readHandleCount()).toBe(1);
    await f.files.releaseChat('group', null);
    expect(f.files.readHandleCount()).toBe(0);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
});
