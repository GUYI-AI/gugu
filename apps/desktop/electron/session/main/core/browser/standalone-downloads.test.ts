import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manageDownloads, type DownloadSaver } from './standalone-downloads';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** The person's answer to the save dialog, given by the test when it wants to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'standalone-downloads-'));
  roots.push(root);
  const events = new EventEmitter();
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const connection = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => { sent.push({ method, params }); return {}; }),
    on: (event: 'event', listener: (message: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void) => events.on(event, listener),
    once: (event: 'closed', listener: () => void) => events.once(event, listener),
  };
  const answer = deferred<string | null>();
  const saver = { chooseFile: vi.fn(() => answer.promise), failed: vi.fn() } satisfies DownloadSaver;
  await manageDownloads(connection, saver, root);
  const behavior = sent.find(call => call.method === 'Browser.setDownloadBehavior')?.params;
  const scratch = String(behavior?.downloadPath);
  const destination = path.join(root, 'chosen', 'report.pdf');
  const begin = (guid = 'g1', suggestedFilename = 'report.pdf') => events.emit('event', { method: 'Browser.downloadWillBegin', params: { guid, url: 'http://site.test/report.pdf', suggestedFilename, frameId: 'f' } });
  const progress = (state: 'inProgress' | 'completed' | 'canceled', guid = 'g1', filePath?: string) =>
    events.emit('event', { method: 'Browser.downloadProgress', params: { guid, state, receivedBytes: 4, totalBytes: 4, ...(filePath ? { filePath } : {}) } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { root, events, sent, saver, answer, scratch, behavior, destination, begin, progress, settle };
}

describe('standalone browser downloads', () => {
  it('has Chrome keep downloads in a private scratch directory and report them', async () => {
    const { behavior, scratch, root } = await fixture();
    expect(behavior).toMatchObject({ behavior: 'allowAndName', eventsEnabled: true });
    expect(path.isAbsolute(scratch)).toBe(true);
    expect(path.dirname(scratch)).toBe(root);
    expect((await stat(scratch)).isDirectory()).toBe(true);
  });

  it('asks where to save the moment the download begins and moves the finished file there', async () => {
    const f = await fixture();
    f.begin();
    await f.settle();
    // The dialog is up while Chrome is still downloading, as it is in the built-in browser.
    expect(f.saver.chooseFile).toHaveBeenCalledExactlyOnceWith('report.pdf');
    const temporary = path.join(f.scratch, 'g1');
    await writeFile(temporary, 'bytes');
    f.answer.resolve(f.destination);
    await f.settle();
    await expect(stat(f.destination)).rejects.toThrow(); // Not finished yet: nothing is moved.
    f.progress('completed', 'g1', temporary);
    await f.settle();
    expect(await readFile(f.destination, 'utf8')).toBe('bytes');
    expect(await readdir(f.scratch)).toEqual([]);
    expect(f.saver.failed).not.toHaveBeenCalled();
  });

  it('moves the file straight away when the download finished before the person chose', async () => {
    const f = await fixture();
    f.begin();
    const temporary = path.join(f.scratch, 'g1');
    await writeFile(temporary, 'already here');
    f.progress('completed', 'g1', temporary);
    await f.settle();
    await expect(stat(f.destination)).rejects.toThrow();
    f.answer.resolve(f.destination);
    await f.settle();
    expect(await readFile(f.destination, 'utf8')).toBe('already here');
    expect(await readdir(f.scratch)).toEqual([]);
  });

  it('cancels the download and deletes what it wrote when the person cancels the dialog', async () => {
    const f = await fixture();
    f.begin();
    await writeFile(path.join(f.scratch, 'g1.crdownload'), 'partial');
    f.answer.resolve(null);
    await f.settle();
    expect(f.sent).toContainEqual({ method: 'Browser.cancelDownload', params: { guid: 'g1' } });
    f.progress('canceled');
    await f.settle();
    expect(await readdir(f.scratch)).toEqual([]);
    expect(f.saver.failed).not.toHaveBeenCalled();
  });

  it('deletes a download that finished before the person cancelled the dialog', async () => {
    const f = await fixture();
    f.begin();
    const temporary = path.join(f.scratch, 'g1');
    await writeFile(temporary, 'done already');
    f.progress('completed', 'g1', temporary);
    f.answer.resolve(null);
    await f.settle();
    expect(await readdir(f.scratch)).toEqual([]);
    expect(f.saver.failed).not.toHaveBeenCalled();
  });

  it('reports a download that fails after a place was chosen and deletes what it wrote', async () => {
    const f = await fixture();
    f.begin();
    await writeFile(path.join(f.scratch, 'g1.crdownload'), 'partial');
    f.answer.resolve(f.destination);
    f.progress('canceled'); // Chrome reports an interrupted download as canceled.
    await f.settle();
    expect(f.saver.failed).toHaveBeenCalledExactlyOnceWith('report.pdf', expect.objectContaining({ message: expect.stringContaining('did not finish') }));
    await expect(stat(f.destination)).rejects.toThrow();
    expect(await readdir(f.scratch)).toEqual([]);
  });

  it('reports a file that cannot be put where the person chose', async () => {
    const f = await fixture();
    f.begin();
    const temporary = path.join(f.scratch, 'g1');
    await writeFile(temporary, 'bytes');
    await writeFile(path.join(f.root, 'chosen'), 'a file, not a directory'); // The destination's parent cannot exist.
    f.answer.resolve(f.destination);
    f.progress('completed', 'g1', temporary);
    await f.settle();
    expect(f.saver.failed).toHaveBeenCalledExactlyOnceWith('report.pdf', expect.any(Error));
    expect(await readdir(f.scratch)).toEqual([]);
  });

  it('keeps downloads apart and ignores other browser events', async () => {
    const f = await fixture();
    f.begin('g1', 'a.txt');
    f.begin('g2', '../../b.txt');
    f.events.emit('event', { method: 'Browser.downloadWillBegin', sessionId: 'page', params: { guid: 'g3', suggestedFilename: 'page-session.txt' } });
    f.events.emit('event', { method: 'Page.loadEventFired', params: {} });
    await f.settle();
    // The file name offered to the dialog never carries a directory.
    expect(f.saver.chooseFile.mock.calls.map(call => call[0])).toEqual(['a.txt', 'b.txt']);
    f.answer.resolve(null);
    await f.settle();
    expect(f.sent.filter(call => call.method === 'Browser.cancelDownload').map(call => call.params?.guid)).toEqual(['g1', 'g2']);
  });

  it('removes the scratch directory when the browser exits and fails what was waiting for it', async () => {
    const f = await fixture();
    f.begin();
    await writeFile(path.join(f.scratch, 'g1.crdownload'), 'partial');
    f.events.emit('closed');
    await f.settle();
    await expect(stat(f.scratch)).rejects.toThrow();
    f.answer.resolve(f.destination);
    await f.settle();
    expect(f.saver.failed).toHaveBeenCalledExactlyOnceWith('report.pdf', expect.objectContaining({ message: expect.stringContaining('did not finish') }));
  });
});
