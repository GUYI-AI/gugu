import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordEntry } from '../contract';

/** 核对用的首尾各取多少个字。 */
const PROBE_CHARS = 32;

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
