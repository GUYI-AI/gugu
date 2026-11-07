import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { readWindowFrame, syncWindowDirectory, writeWindowFrame } from './disk-frame.ts';
import type { WindowCacheContext, WindowBudget, WindowSourceLocator, SourceSnapshot } from './types';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function sourceLocatorScope(harness: 'claude' | 'codex', providerSessionId: string): string {
  if (providerSessionId.length > 256 || !providerSessionId) throw new Error('Invalid native session id');
  return hash(JSON.stringify(['gugu.native-source/1', harness, providerSessionId]));
}
function sourceKey(harness: 'claude' | 'codex', providerSessionId: string, cursor = 'source-current') {
  const scope = sourceLocatorScope(harness, providerSessionId);
  return { scope, sourceLineage: scope, decoderVersion: 1, kind: 'head' as const, cursor };
}
async function directoryFor(cacheDirectory: string): Promise<string> {
  // The host supplies a durable cacheDirectory; source metadata survives projection eviction.
  const directory = join(cacheDirectory, 'source-locators');
  await mkdir(directory, { recursive: true });
  await syncWindowDirectory(cacheDirectory);
  return directory;
}
function validLocator(value: WindowSourceLocator, harness: string, id: string): boolean {
  return value?.version === 1 && value.harness === harness && value.providerSessionId === id &&
    typeof value.path === 'string' && value.path.startsWith('/') && Buffer.byteLength(value.path) <= 2048 &&
    /^[a-f0-9]{64}$/.test(value.sourceLineage) && value.source &&
    [value.source.sourceId, value.source.sourceInstance, value.source.snapshotRevision].every(v => /^[a-f0-9]{64}$/.test(v)) &&
    Number.isSafeInteger(value.source.size) && value.source.size >= 0;
}

export async function writeSourceLocator(cacheDirectory: string, locator: WindowSourceLocator): Promise<void> {
  const key = sourceKey(locator.harness, locator.providerSessionId);
  if (!validLocator(locator, locator.harness, locator.providerSessionId)) throw new Error('Invalid native source locator');
  const source = locator.source;
  const encoded = Buffer.from(JSON.stringify({ version: 1, harness: locator.harness,
    providerSessionId: locator.providerSessionId, path: locator.path, sourceLineage: locator.sourceLineage,
    source: { sourceId: source.sourceId, sourceInstance: source.sourceInstance, snapshotRevision: source.snapshotRevision, size: source.size } }));
  await writeWindowFrame(await directoryFor(cacheDirectory), key, encoded);
}

export async function readSourceLocator(cacheDirectory: string, harness: 'claude' | 'codex',
  providerSessionId: string, budget: WindowBudget) {
  const frame = await readWindowFrame(join(cacheDirectory, 'source-locators'), sourceKey(harness, providerSessionId), budget);
  if (frame.kind === 'miss') return frame;
  if (frame.bytes.length > 4096) throw new Error('Oversized native source locator');
  budget.charge('decodedBytes', frame.bytes.length);
  const locator = JSON.parse(Buffer.from(frame.bytes).toString('utf8')) as WindowSourceLocator;
  if (!validLocator(locator, harness, providerSessionId)) throw new Error('Invalid native source locator');
  return { kind: 'hit' as const, locator };
}

/** Latest captured record start is independent of its body length and projection cache. */
export async function readCapturedRecordStart(cacheDirectory: string, harness: 'claude' | 'codex',
  providerSessionId: string, source: SourceSnapshot, budget: WindowBudget) {
  const frame = await readWindowFrame(join(cacheDirectory, 'source-locators'), sourceKey(harness, providerSessionId, 'record-current'), budget);
  if (frame.kind === 'miss') return frame;
  if (frame.bytes.length > 4096) throw new Error('Oversized captured record locator');
  budget.charge('decodedBytes', frame.bytes.length);
  const saved = JSON.parse(Buffer.from(frame.bytes).toString('utf8')) as { source: SourceSnapshot; recordStart: number; recordEnd: number };
  if (saved.source.sourceId !== source.sourceId || saved.source.sourceInstance !== source.sourceInstance ||
    saved.source.snapshotRevision !== source.snapshotRevision || saved.source.size !== source.size)
    return { kind: 'reset' as const, reason: 'source_changed' as const };
  if (!Number.isSafeInteger(saved.recordStart) || !Number.isSafeInteger(saved.recordEnd) ||
    saved.recordStart < 0 || saved.recordStart > saved.recordEnd || saved.recordEnd > source.size)
    throw new Error('Invalid captured record locator');
  return { kind: 'hit' as const, range: { start: saved.recordStart, end: saved.recordEnd } };
}

/** Same physical binding as openWindowByteSource, using the descriptor that supplied these bytes. */
async function snapshotFor(path: string, file: FileHandle): Promise<SourceSnapshot> {
  const canonical = await realpath(path), descriptor = await file.stat({ bigint: true }), named = await stat(path, { bigint: true });
  const identity = (info: typeof descriptor) => `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  if (!descriptor.isFile() || identity(descriptor) !== identity(named)) throw new Error('Native source replaced during capture');
  if (descriptor.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Native source offset is not representable');
  const sourceId = hash(canonical);
  return { sourceId, sourceInstance: hash(`${sourceId}:${identity(descriptor)}`),
    snapshotRevision: hash(`${identity(descriptor)}:${descriptor.size}:${descriptor.mtimeNs}:${descriptor.ctimeNs}`), size: Number(descriptor.size) };
}

/** One capture owns one current record, with no line string or history-sized collection. */
export function createRecordLocatorCapture(context: WindowCacheContext, harness: 'claude' | 'codex', providerSessionId: string) {
  let instance = '', next = -1, recordStart = 0, previousByte = -1;
  return async (path: string, file: FileHandle, bytes: Uint8Array, position: number): Promise<void> => {
    if (bytes.length > 64 * 1024) throw new Error('Capture source block must be sliced before delivery');
    const source = await snapshotFor(path, file);
    let currentStart = source.sourceInstance !== instance || position !== next ? position : recordStart;
    const firstRecordStart = currentStart;
    let lastCompleteStart: number | null = null, lastCompleteEnd = position;
    for (let offset = bytes.indexOf(10); offset >= 0; offset = bytes.indexOf(10, offset + 1)) {
      lastCompleteStart = currentStart;
      lastCompleteEnd = position + offset - ((offset === 0 ? previousByte : bytes[offset - 1]) === 13 ? 1 : 0);
      currentStart = position + offset + 1;
    }
    const end = position + bytes.length;
    const locator: WindowSourceLocator = { version: 1, harness, providerSessionId, path,
      source, sourceLineage: source.sourceInstance };
    const directory = await directoryFor(context.cacheDirectory);
    // Each raw range is independently seekable. Its body remains encoded JSON, not decoded UTF-8.
    const raw = { version: 1, source, sourceLineage: locator.sourceLineage, start: position, end,
      firstRecordStart, recordStart: currentStart, lastCompleteStart, complete: currentStart === end };
    await writeWindowFrame(directory, sourceKey(harness, providerSessionId, `raw:${Math.floor(position / (64 * 1024))}`), Buffer.from(JSON.stringify(raw)));
    await writeWindowFrame(directory, sourceKey(harness, providerSessionId, 'record-current'), Buffer.from(JSON.stringify({
      version: 1, source, recordStart: currentStart === end ? lastCompleteStart : currentStart,
      recordEnd: currentStart === end ? lastCompleteEnd : end,
    })));
    await writeSourceLocator(context.cacheDirectory, locator);
    next = end; instance = source.sourceInstance; recordStart = currentStart; previousByte = bytes.at(-1) ?? previousByte;
  };
}
