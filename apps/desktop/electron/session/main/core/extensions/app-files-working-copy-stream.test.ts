import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ capabilities: new Set<string>(), machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null), remote: vi.fn(), root: '' }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, app: { getPath: () => '/tmp' } }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: () => undefined } }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap), get: () => ({ manifest: { id: 'reader' } }) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: {}, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine, callOnSessionMachine: f.remote }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => ({ workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' }) }));
vi.mock('@main/core/files/file-tree/projector', () => ({ FileTreeProjector: class {} }));

const { readAppFile, readAppFileText } = await import('./app-files');
const { setMachineFileStreams: setWorkingCopyStreams, MACHINE_FILE_STREAM } = await import('@main/core/files/machine-file-streams');
const { createWorkingCopyStreamer, releaseWorkingCopies } = await import('./working-copy-files');
const { etagOf } = await import('@main/core/files/workspace-transfer');
const { remoteFileStreams } = await import('../../../../projectFileSsh');

const workspace = 'session:11111111-1111-4111-8111-111111111111';
const page = () => ({ pageId: 3, extensionId: 'reader', handed: null }) as never;
const text = 'x'.repeat(1_300_000);
const remoteFile = { size: text.length, etag: 'etag-1' };

/** A machine a device link reaches: one stream per open, front to back from where it was opened. */
function fakeStreams(linked = true) {
  const opened: { from: number; request: Record<string, unknown> }[] = [];
  return { opened, linked: vi.fn(async () => linked), open: vi.fn(async (_device: string, type: string, request: (offset: number, stream: string, etag?: string) => Record<string, unknown>, pin: { etag?: string }, from: number) => {
    expect(type).toBe(MACHINE_FILE_STREAM);
    opened.push({ from, request: request(from, 's', pin.etag) });
    let next = from;
    return { ...remoteFile, dispose: vi.fn(async () => undefined), read: async (offset: number, length: number) => {
      if (offset !== next) throw new Error('A file stream is read front to back');
      next += length;
      return new Uint8Array(Buffer.from(text.slice(offset, offset + length)));
    } };
  }) };
}

beforeEach(async () => {
  releaseWorkingCopies(3);
  f.capabilities.clear(); f.capabilities.add('files:read'); f.capabilities.add('files:read:all-machines');
  vi.clearAllMocks();
  f.machine.mockResolvedValue({ deviceId: 'device-b', projectId: 'p' });
  // The pieces the machine's own call answers: the anchor (no bytes) and, without a link, every piece.
  f.remote.mockImplementation(async (_app, _session, _method, args: { offset: number; length: number }) => ({ there: true,
    value: { ...remoteFile, offset: args.offset, data: Buffer.from(text.slice(args.offset, args.offset + args.length)).toString('base64') } }));
  f.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wc-stream-root-')));
});

afterEach(async () => {
  setWorkingCopyStreams(null);
  await fsp.rm(f.root, { recursive: true, force: true });
});

it('reads another machine\'s file whole from one stream over its link, the call only anchoring its version', async () => {
  const streams = fakeStreams();
  setWorkingCopyStreams(streams);
  const read = await readAppFileText(page(), { ref: { workspace, id: 'big.txt' } });
  expect(read.content).toBe(text);
  expect(streams.open).toHaveBeenCalledOnce();
  expect(streams.opened[0]).toMatchObject({ from: 0, request: { ref: { workspace, id: 'big.txt' }, offset: 0, etag: 'etag-1' } });
  expect(f.remote).toHaveBeenCalledOnce();
  expect(f.remote.mock.calls[0]![3]).toMatchObject({ offset: 0, length: 0 });
  expect(streams.linked).toHaveBeenCalledOnce();
});

it('a linked machine whose link cannot go on fails the read, never falls back to pieces', async () => {
  const streams = fakeStreams();
  streams.linked.mockRejectedValueOnce(new Error('The SSH connection to this machine is not available (unreachable)'));
  setWorkingCopyStreams(streams);
  await expect(readAppFileText(page(), { ref: { workspace, id: 'big.txt' } })).rejects.toThrow(/not available/);
  expect(f.remote).not.toHaveBeenCalled();
});

it('a machine no device link reaches keeps one call per piece', async () => {
  const streams = fakeStreams(false);
  setWorkingCopyStreams(streams);
  expect((await readAppFileText(page(), { ref: { workspace, id: 'big.txt' } })).content).toBe(text);
  expect(streams.open).not.toHaveBeenCalled();
  expect(f.remote.mock.calls.length).toBeGreaterThan(2);
});

it('a read that jumps starts the stream again there, of the same version', async () => {
  const streams = fakeStreams();
  setWorkingCopyStreams(streams);
  const ref = { workspace, id: 'big.txt' };
  expect(Buffer.from((await readAppFile(page(), { ref, offset: 0, length: 10 })).data).toString()).toBe(text.slice(0, 10));
  expect(Buffer.from((await readAppFile(page(), { ref, offset: 10, length: 10 })).data).toString()).toBe(text.slice(10, 20));
  expect(Buffer.from((await readAppFile(page(), { ref, offset: 900_000, length: 5 })).data).toString()).toBe(text.slice(900_000, 900_005));
  expect(streams.opened.map(open => open.from)).toEqual([0, 900_000]);
  expect(streams.opened[1]!.request).toMatchObject({ etag: 'etag-1', offset: 900_000 });
  expect(f.remote).toHaveBeenCalledOnce();
});

it('a file that changed under the stream is said so, not mixed', async () => {
  const streams = fakeStreams();
  streams.open.mockImplementationOnce(async () => ({ ...remoteFile, dispose: vi.fn(async () => undefined), read: async (): Promise<Uint8Array<ArrayBuffer>> => { throw new Error('Local file changed during read'); } }));
  setWorkingCopyStreams(streams);
  await expect(readAppFile(page(), { ref: { workspace, id: 'big.txt' }, offset: 0, length: 10 })).rejects.toMatchObject({ code: 'content-changed' });
});

it('the machine streams its working copy\'s file to its own account only, of the version asked, inside the working copy', async () => {
  f.machine.mockResolvedValue(null);
  await fsp.writeFile(path.join(f.root, 'clip.bin'), Buffer.from('0123456789'));
  const etag = etagOf(await fsp.stat(path.join(f.root, 'clip.bin'), { bigint: true }));
  const stream = createWorkingCopyStreamer(async () => 'owner', async (projectId, workspaceId) => {
    if (projectId !== 'p' || workspaceId !== 'w') throw new Error('No such workspace');
    return f.root;
  });
  const written: [number, string][] = [];
  const heads: { size: number; etag: string }[] = [];
  // The head is said before the first byte.
  const context = (userId: string) => ({ userId, signal: new AbortController().signal,
    head: (version: { size: number; etag: string }) => { expect(written).toHaveLength(0); heads.push(version); },
    write: async (offset: number, bytes: Uint8Array) => { written.push([offset, Buffer.from(bytes).toString()]); } });
  const request = (extra: Record<string, unknown> = {}) => ({ ref: { workspace, id: 'clip.bin' }, offset: 3, etag, stream: 's', ...extra });
  await expect(stream(request(), context('someone-else'))).rejects.toMatchObject({ code: 'denied' });
  await expect(stream(request({ etag: 'old' }), context('owner'))).rejects.toThrow(/changed/);
  await expect(stream(request({ ref: { workspace, id: '../escape.bin' } }), context('owner'))).rejects.toThrow();
  expect(await stream(request(), context('owner'))).toEqual({ size: 10, etag });
  expect(written).toEqual([[3, '3456789']]);
  // A workspace's file, named as the window's chunk read names it: the same version check and the same fence.
  const place = (extra: Record<string, unknown> = {}) => ({ place: { projectId: 'p', workspaceId: 'w' }, path: 'clip.bin', offset: 8, etag, stream: 's', ...extra });
  await expect(stream(place(), context('someone-else'))).rejects.toMatchObject({ code: 'denied' });
  await expect(stream(place({ path: '../escape.bin' }), context('owner'))).rejects.toThrow();
  await expect(stream(place({ place: { projectId: 'p', workspaceId: 'other' } }), context('owner'))).rejects.toThrow(/No such workspace/);
  await expect(stream(place({ ref: { workspace, id: 'clip.bin' } }), context('owner'))).rejects.toMatchObject({ code: 'invalid' });
  written.length = 0;
  expect(await stream(place(), context('owner'))).toEqual({ size: 10, etag });
  expect(written).toEqual([[8, '89']]);
  // No version named: the one on disk, said in the head before its bytes.
  written.length = 0; heads.length = 0;
  const { etag: _pinned, ...unpinned } = place({ offset: 0 });
  expect(await stream(unpinned, context('owner'))).toEqual({ size: 10, etag });
  expect(heads).toEqual([{ size: 10, etag }]);
  expect(written).toEqual([[0, '0123456789']]);
  // A refused version says no head and sends no byte.
  written.length = 0; heads.length = 0;
  await expect(stream(place({ etag: 'old' }), context('owner'))).rejects.toThrow(/changed/);
  expect(heads).toEqual([]);
  expect(written).toEqual([]);
});

it('whether a machine streams comes from its mapping; a linked machine streams or fails, never quietly reads otherwise', async () => {
  const links = (open: { ok: boolean; reason?: string; controlOnly?: true }, protocol: number | null) => ({
    open: vi.fn(async () => open), protocol: vi.fn(() => protocol), hold: vi.fn(() => () => undefined), send: vi.fn(() => true),
  }) as never;
  const account = async () => 'account-a';
  const unlinked = links({ ok: true }, 19);
  expect(await remoteFileStreams(() => unlinked, account, async () => false).linked('device-b')).toBe(false);
  expect((unlinked as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
  expect(await remoteFileStreams(() => links({ ok: true }, 19), account, async () => true).linked('device-b')).toBe(true);
  // An older server is linked too: its stream is refused as outdated (and the server upgraded), not read by pieces.
  expect(await remoteFileStreams(() => links({ ok: false, reason: 'outdated', controlOnly: true }, 18), account, async () => true).linked('device-b')).toBe(true);
  await expect(remoteFileStreams(() => links({ ok: false, reason: 'unreachable' }, null), account, async () => true).linked('device-b')).rejects.toThrow(/unreachable/);
  await expect(remoteFileStreams(() => links({ ok: true }, null), account, async () => true).linked('device-b')).rejects.toThrow(/closed/);
  await expect(remoteFileStreams(() => null, account, async () => true).linked('device-b')).rejects.toThrow(/not available/);
});
