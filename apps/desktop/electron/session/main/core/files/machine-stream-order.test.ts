import { afterEach, expect, it, vi } from 'vitest';
import { setMachineFileStreams, streamedRange, type FileStreamBytes } from './machine-file-streams';

afterEach(() => { setMachineFileStreams(null); vi.useRealTimers(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const request = () => ({});
function fixture() {
  const opened: FileStreamBytes[] = [];
  const open = vi.fn(async (_device: string, _type: string, _request: unknown, _pin: unknown, from: number) => {
    let at = from;
    const stream = { size: 8, etag: 'v1', dispose: vi.fn(async () => {}), read: vi.fn(async (offset: number, length: number) => {
      if (offset !== at) throw new Error('out of order');
      at += length; return new Uint8Array(length).fill(offset);
    }) };
    opened.push(stream); return stream;
  });
  setMachineFileStreams({ linked: async () => true, open });
  return { opened, open };
}

it('serializes overlapping callers of the same file while another file proceeds', async () => {
  const f = fixture(); const gate = deferred();
  await streamedRange('overlap', 'd', null, request, 0, 2);
  const read = f.opened[0]!.read;
  const original = read;
  const paused = vi.fn(async (offset: number, length: number) => { await gate.promise; return original(offset, length); });
  f.opened[0]!.read = paused;
  const first = streamedRange('overlap', 'd', null, request, 2, 2);
  const second = streamedRange('overlap', 'd', null, request, 4, 4);
  await streamedRange('other', 'd', null, request, 0, 8);
  expect(f.opened[0]!.dispose).not.toHaveBeenCalled();
  gate.resolve(); await first; await second;
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.opened[0]!.dispose).toHaveBeenCalledOnce();
});

it('a long pending read is not disposed by its idle timer', async () => {
  vi.useFakeTimers(); const f = fixture(); const gate = deferred();
  await streamedRange('idle', 'd', null, request, 0, 2);
  f.opened[0]!.read = vi.fn(async () => { await gate.promise; return new Uint8Array(2); });
  const pending = streamedRange('idle', 'd', null, request, 2, 2);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(f.opened[0]!.dispose).not.toHaveBeenCalled();
  gate.resolve(); await pending;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.opened[0]!.dispose).toHaveBeenCalledOnce();
});

it('a failed range does not poison the next caller', async () => {
  const f = fixture(); await streamedRange('retry', 'd', null, request, 0, 2);
  f.opened[0]!.read = async () => { throw new Error('lost'); };
  await expect(streamedRange('retry', 'd', null, request, 2, 2)).rejects.toThrow('lost');
  await expect(streamedRange('retry', 'd', null, request, 0, 8)).resolves.toMatchObject({ size: 8 });
});
