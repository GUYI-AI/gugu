import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { scheduleExternalForkCapture } from './fork-capture';
import { mapSessionRowToSession } from './utils';

let requestSequence = 0;

/** 这条会话(未归档时)。外部 fork 由这一次读顺带扫一趟,扫到的经 session:created 进侧栏。 */
export async function getUnarchivedSession(sessionId: string) {
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  log.info('getUnarchivedSession: enter', { requestId, sessionId });
  try {
    // Captured forks land after this read returns and reach the sidebar via
    // session:created events — the list call itself stays fast.
    scheduleExternalForkCapture(sessionId);
    const rows = await db
      .select()
      .from(sessions)
      // spec session-graph:会话的可见性只有一个过滤器 —— `sessions.archived_at`。侧栏这一列就是
      // 从这里来的,少了它,归档过的会话会在下一次刷新时原地复活(渲染层那一次乐观移行看起来是对的,
      // 而 reload 之后就露馅)。
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.archivedAt)
        )
      );
    const result = rows.map((r) => mapSessionRowToSession(r, false));
    log.info('getUnarchivedSession: return', {
      requestId,
      sessionId,
      count: result.length,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    log.error('getUnarchivedSession: error', {
      requestId,
      sessionId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
