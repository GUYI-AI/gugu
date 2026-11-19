import { existsSync, readdirSync, renameSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import { BROWSER_PARTITION_PREFIX, LEGACY_BROWSER_PARTITION_PREFIX } from '@shared/browser';

const PERSIST_PREFIX = 'persist:';
const CURRENT_DIR_PREFIX = BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length);
const LEGACY_DIR_PREFIX = LEGACY_BROWSER_PARTITION_PREFIX.slice(PERSIST_PREFIX.length);

function defaultPartitionsDir(): string {
  return join(app.getPath('userData'), 'Partitions');
}

function isKeptPartition(name: string, dirPrefix: string): boolean {
  return name.startsWith(`${dirPrefix}-profile`) || name.startsWith(`${dirPrefix}-isolated-`);
}

/**
 * 内置浏览器的分区改过名(`persist:emdash-browser…` → `persist:gugu-browser…`)。一个分区的 cookie、登录态、
 * 本地存储都在 `userData/Partitions/<分区名去掉 persist:>` 这个目录里 —— 只改名字不搬目录,用户在内置浏览器
 * 里登过的站点就会全部掉线,而且界面上不会有任何提示。
 *
 * 所以要在打开任何浏览器会话**之前**(开机时、注册 RPC 之前)同步把目录挪过去:
 * - 只挪具名配置(`-profile…`)和按任务隔离(`-isolated-…`)的目录;旧标签页分区保留,只由用户明确清除浏览数据
 * - 新名字的目录已经存在就两边都不动 —— 两份都有数据时不替用户挑
 */
export function migrateLegacyBrowserPartitionDirs(partitionsDir: string = defaultPartitionsDir()): void {
  let names: string[];
  try {
    names = readdirSync(partitionsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isKeptPartition(name, LEGACY_DIR_PREFIX)) continue;
    const target = `${CURRENT_DIR_PREFIX}${name.slice(LEGACY_DIR_PREFIX.length)}`;
    if (existsSync(join(partitionsDir, target))) {
      log.warn('Browser partition: legacy and current directories both exist; leaving both', {
        legacy: name,
        current: target,
      });
      continue;
    }
    try {
      renameSync(join(partitionsDir, name), join(partitionsDir, target));
      log.info('Browser partition: moved legacy directory to its new name', { from: name, to: target });
    } catch (error) {
      log.warn('Browser partition: failed to move legacy directory', {
        from: name,
        to: target,
        error: String(error),
      });
    }
  }
}

/**
 * Existing browser partitions, including retired per-tab ones. Enumerating is
 * read-only: old partitions can contain unsaved site data. The explicit browsing
 * data controls may clear them; startup never removes them by their old name.
 */
export async function listPersistedBrowserPartitions(
  partitionsDir: string = defaultPartitionsDir()
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(partitionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() &&
    [CURRENT_DIR_PREFIX, LEGACY_DIR_PREFIX].some((prefix) =>
      entry.name.startsWith(`${prefix}-`)
    )
  ).map((entry) => `${PERSIST_PREFIX}${entry.name}`);
}
