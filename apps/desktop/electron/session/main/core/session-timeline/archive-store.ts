/**
 * Where each session's timeline checkpoint lives (one archive file per session), and keeping their total bounded.
 *
 * Opening a session folds its record on the fold thread from the last checkpoint (`fold.ts`), which reads it, checks
 * it (version, resume point; anything off means a fold from the start) and writes the next one atomically. A
 * checkpoint is derived data: deleting one only costs the next open a whole fold, on that thread.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

import { log } from '@main/lib/logger';

/** 存档目录名。放在 app 自己的 userData 下，与用户的项目目录无关。 */
const DIRECTORY_NAME = 'session-timeline-archive';

/** 存档总量上限：超了就按最后使用时间从旧到新删。 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

let rootDir: string | null = null;
let resolved = false;

/**
 * 存档目录。取不到就返回 null —— **不存档只是慢，不是错**，所以这里不 throw：
 * 一个拿不到 userData 的环境（单测、无头工具）照样应该能打开会话。
 */
function root(): string | null {
  if (resolved) return rootDir;
  resolved = true;
  try {
    rootDir = join(app.getPath('userData'), DIRECTORY_NAME);
  } catch {
    rootDir = null;
  }
  return rootDir;
}

function fileFor(sessionId: string): string | null {
  const dir = root();
  if (!dir) return null;
  // 会话 id 是 uuid；仍然挡一手路径穿越 —— 它会被拼进文件名。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return join(dir, `${sessionId}.json`);
}
/** Where a session's archive lives; the fold thread reads and writes it there too (`fold.ts`). */
export { fileFor as timelineArchiveFile };

export async function dropTimelineArchive(sessionId: string): Promise<void> {
  const file = fileFor(sessionId);
  if (!file) return;
  await rm(file, { force: true }).catch(() => {});
}

/**
 * 把总量压回上限以内，从**最久没用过的**开始删。
 *
 * 存档是纯派生数据，删掉最坏的后果是下次那条会话慢一次 —— 所以这里可以放心地删，
 * ❌ 但不能因为「删不动」就让调用方失败。
 */
export async function pruneTimelineArchives(): Promise<void> {
  const dir = root();
  if (!dir) return;
  try {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: { path: string; bytes: number; atime: number }[] = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      files.push({ path, bytes: info.size, atime: info.mtimeMs });
      total += info.size;
    }
    if (total <= MAX_TOTAL_BYTES) return;
    files.sort((a, b) => a.atime - b.atime);
    for (const one of files) {
      if (total <= MAX_TOTAL_BYTES) break;
      await rm(one.path, { force: true }).catch(() => {});
      total -= one.bytes;
    }
  } catch (error) {
    log.warn('sessionTimeline: 存档清理失败', { error: String(error) });
  }
}
