import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import { zstdFrames } from './zstd-frames';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordEntry, RecordImageRef } from '../contract';

/** 核对用的首尾各取多少个字。 */
const PROBE_CHARS = 32;
/** 一张图读回来的上限。位置来自存档,存档坏了也不许让它申请一块离谱的内存。 */
const MAX_IMAGE_CHARS = 64 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** V8 implements a substring as a view of its parent, so a kept probe would keep the whole picture on the heap. */
function detached(text: string): string {
  return Buffer.from(text, 'latin1').toString('latin1');
}

/**
 * 给一行解出来的工具图记下原文位置(`RecordImageRef`),`lineStart` 是这一行第一个字节在文件里的位置。
 *
 * 图的 base64 在记录里是原样一段(codex 是 `data:<type>;base64,` 后面那段,claude 是 `source.data`):解码只是把它从
 * JSON 里切出来,所以这一行的原文里找得到同一串字。找不到(写记录的那一家转义了 `/` 之类)就记 null,那一张照旧随存档
 * 存原图 —— 只是省不下,不会错。
 */
export function locateImages(entries: RecordEntry[], line: string, lineStart: number, path: string): void {
  let from = 0;
  for (const entry of entries) {
    const event = entry.event;
    if (event?.kind !== 'tool_update' || !event.images?.length) continue;
    (entry as Extract<RecordEntry, { event: NormalizedEvent }>).imageOrigins = event.images.map(({ data }) => {
      if (data.length < PROBE_CHARS * 2) return null; // 小图随存档存着就是了,不值一次读盘
      let at = line.indexOf(data, from);
      if (at < 0) at = line.indexOf(data);
      if (at < 0) return null;
      from = at + data.length;
      return {
        path,
        start: lineStart + Buffer.byteLength(line.slice(0, at), 'utf8'),
        chars: data.length,
        head: detached(data.slice(0, PROBE_CHARS)),
        tail: detached(data.slice(-PROBE_CHARS)),
      };
    });
  }
}

/**
 * 按位置把一张图从记录里读回来。读不到、长度不对、首尾对不上、读出来的不是 base64,一律回 null:
 * 记录只追加,位置一直有效;对不上只可能是文件被改写过,那时❌ 不许把别的字节当图交出去。
 */
export async function readRecordImage(ref: RecordImageRef): Promise<string | null> {
  if (!ref.path.endsWith('.jsonl') || !Number.isSafeInteger(ref.start) || ref.start < 0
    || !Number.isSafeInteger(ref.chars) || ref.chars <= 0 || ref.chars > MAX_IMAGE_CHARS) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(ref.path, 'r');
    const buffer = Buffer.alloc(ref.chars);
    const { bytesRead } = await handle.read(buffer, 0, ref.chars, ref.start);
    if (bytesRead !== ref.chars) return null;
    const data = buffer.toString('latin1');
    return data.startsWith(ref.head) && data.endsWith(ref.tail) && BASE64.test(data) ? data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * A filled-in turn's picture (resume-tail), by its place in the session's record as the record is now (`path`): a
 * `.jsonl`, or the `.zst` Codex archived it into, whose decoded offsets are the same. A `.zst` is decompressed as a
 * stream up to the picture, holding one chunk at a time; frames that end before it are skipped when they say their size.
 * Not found, a different length or a different head/tail = null, as a picture that was not kept.
 */
export async function readRecordPicture(path: string, place: { start: number; chars: number; head: string; tail: string }): Promise<string | null> {
  if (!path.endsWith('.zst')) return readRecordImage({ path, ...place });
  if (!Number.isSafeInteger(place.start) || place.start < 0 || !Number.isSafeInteger(place.chars) || place.chars <= 0
    || place.chars > MAX_IMAGE_CHARS) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const end = place.start + place.chars;
    let decoded = 0, got = 0;
    const parts: Buffer[] = [];
    for await (const frame of zstdFrames(handle, size)) {
      const frameSize = frame.contentSize === null ? null : Number(frame.contentSize);
      if (frameSize !== null && decoded + frameSize <= place.start) { decoded += frameSize; continue; }
      for await (const chunk of Readable.from(compressed(handle, frame.start, frame.end)).pipe(createZstdDecompress())) {
        const bytes = chunk as Buffer;
        const from = Math.max(place.start - decoded, 0);
        const to = Math.min(end - decoded, bytes.length);
        if (to > from) { parts.push(Buffer.from(bytes.subarray(from, to))); got += to - from; }
        decoded += bytes.length;
        if (got === place.chars) break;
      }
      if (got === place.chars) {
        const data = Buffer.concat(parts).toString('latin1');
        return data.startsWith(place.head) && data.endsWith(place.tail) && BASE64.test(data) ? data : null;
      }
      if (decoded >= end) return null;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** One frame's compressed bytes, a read at a time. */
async function* compressed(handle: FileHandle, from: number, last: number): AsyncGenerator<Buffer> {
  for (let at = from; at <= last;) {
    const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, last - at + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
    if (bytesRead === 0) return;
    at += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/** `SessionRecordSource.checkAt` for a plain JSONL record: its inode and the hash of the 4 KiB before `position`. */
export async function jsonlCheckAt(path: string, position: number): Promise<string | null> {
  if (path.endsWith('.zst') || !Number.isSafeInteger(position) || position < 0) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (info.size < position) return null;
    const from = Math.max(0, position - CHECK_BYTES);
    const buffer = Buffer.alloc(position - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    return `${info.ino}:${createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')}`;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
const CHECK_BYTES = 4096;
