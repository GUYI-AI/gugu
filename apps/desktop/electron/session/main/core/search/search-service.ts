import { eq } from 'drizzle-orm';
import { db, sqlite } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import type {
  CommandPaletteQuery,
  SearchItem,
  SearchItemKind,
  TaskTurnHit,
  WorkspaceFileHit,
} from '@shared/core/search';
import { sessionEvents } from '../sessions/session-events';
import { mapSessionRowToSession } from '../sessions/utils';
import { taskName } from '../sessions/task-name';
import { searchTaskTurnMatches } from './task-turn-search';
import { textCondition } from './text-condition';
import { workspaceFileIndexService } from './workspace-file-index-service';
import { taskTurnIndexStatus } from '@main/db/search-backfill-state';
import { nativeConversationHistoryFloor } from '../sessions/native-publication-host';
import { historyTime } from '@gugu/core/shared/conversationHistoryTime';

type FtsRow = {
  item_type: string;
  item_id: string;
  title: string;
  rank: number;
};

type RecentSessionRow = {
  id: string;
  agent_display_name: string | null;
  last_interacted_at: string | null;
};

/** 已下架的 SSH 远程工作区(#6264)上的会话原样留在库里、也可能早已写进 search_index:查询时按会话的工作区排除。 */
const RETIRED_WORKSPACE = `(w.kind = 'byoi' OR w.location = 'remote' OR w.type != 'local')`;
const LOCAL_SESSIONS_ONLY = `NOT EXISTS (SELECT 1 FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
  WHERE s.id = search_index.item_id AND ${RETIRED_WORKSPACE})`;

class SearchService {
  taskTurnIndexStatus() { return taskTurnIndexStatus(sqlite); }
  initialize(): void {
    sessionEvents.on('session:created', (session) => void this.upsertSession(session));
    // Every change of a task's one name is announced here (renameSession.ts), bound names included:
    // a rename, a publish, another device, and the roster projection filling in at sign-in.
    sessionEvents.on('session:renamed', (sessionId) => {
      const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
      if (row) void this.upsertSession(mapSessionRowToSession(row));
    });
    // 已归档任务离开活动搜索,历史仍保留。
    sessionEvents.on('session:archived', (sessionId) =>
      this.removeByType('session', sessionId)
    );

    // Commands and (before groups were the only container) projects were indexed by earlier releases.
    sqlite.prepare("DELETE FROM search_index WHERE item_type IN ('command', 'project')").run();
    this.backfill();
  }

  searchFiles(workspaceId: string, query: string, limit?: number): WorkspaceFileHit[] {
    return workspaceFileIndexService.searchFiles(workspaceId, query, limit);
  }

  search({ query }: CommandPaletteQuery): SearchItem[] {
    if (!query.trim()) return this.recents();

    const condition = textCondition(query, 'search_index', ['title', 'keywords']);
    if (!condition) return [];
    let rows: FtsRow[];
    try {
      rows = sqlite.prepare(`SELECT item_type, item_id, title, ${condition.sql.includes('MATCH') ? 'bm25(search_index)' : '0'} AS rank
        FROM search_index WHERE ${condition.sql} AND ${LOCAL_SESSIONS_ONLY} ORDER BY rank LIMIT 30`).all(...condition.params) as FtsRow[];
    } catch (e) {
      log.warn('SearchService: FTS query failed', { query, error: String(e) });
      return [];
    }

    const results: SearchItem[] = rows.map((r) => ({
      kind: r.item_type as SearchItemKind,
      id: r.item_id,
      title: r.title,
      subtitle: '',
      score: r.rank,
    }));


    return results;
  }

  /** What was said in local tasks, newest first: matched off the main thread (task-turn-matches.ts), named here. */
  async searchTaskTurns(query: string, limit?: number): Promise<TaskTurnHit[]> {
    const size = Math.min(Math.max(limit ?? 30, 1), 100), hits: TaskTurnHit[] = [];
    const floors = new Map<string, string | null>(), retained = new Set<string>();
    for (let offset = 0; hits.length < size; offset += size) {
      const batch = await searchTaskTurnMatches(query, size, offset);
      await Promise.all([...new Set(batch.map(hit => hit.sessionId))].filter(id => !floors.has(id))
        .map(async id => { floors.set(id, await nativeConversationHistoryFloor(id)); }));
      for (const { agentDisplayName, messageTime, ...match } of batch) {
        const floor = floors.get(match.sessionId);
        if (floor && (messageTime === undefined || messageTime < historyTime(floor))) continue;
        const key = JSON.stringify([match.sessionId, match.itemId]);
        if (retained.has(key)) continue;
        retained.add(key);
        hits.push({ ...match, title: taskName({ id: match.sessionId, config: { agentDisplayName: agentDisplayName ?? undefined } }) });
        if (hits.length === size) break;
      }
      if (batch.length < size) break;
    }
    return hits;
  }

  /** 没有输入时:最近交互的任务。 */
  private recents(): SearchItem[] {
    const rows = sqlite
      .prepare(
        `SELECT c.id, json_extract(c.config, '$.agentDisplayName') AS agent_display_name, c.last_interacted_at
         FROM sessions c
         WHERE c.archived_at IS NULL AND c.automation_run_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = c.workspace_id AND ${RETIRED_WORKSPACE})
         ORDER BY c.last_interacted_at DESC
         LIMIT 10`
      )
      .all() as RecentSessionRow[];

    return rows.map((r) => ({
      kind: 'session' as const,
      id: r.id,
      title: taskName({ id: r.id, config: { agentDisplayName: r.agent_display_name ?? undefined } }),
      lastInteractedAt: r.last_interacted_at,
      subtitle: '',
      score: 0,
    }));
  }

  /** 会话按标题搜,外加它工作区的分支名与关联 issue。 */
  private async upsertSession(session: Session): Promise<void> {
    let branchName: string | undefined;
    if (session.workspaceId) {
      const [ws] = await db
        .select({ branchName: workspaces.branchName })
        .from(workspaces)
        .where(eq(workspaces.id, session.workspaceId))
        .limit(1);
      branchName = ws?.branchName ?? undefined;
    }
    const keywords = [branchName, session.linkedIssue?.identifier, session.linkedIssue?.title]
      .filter(Boolean)
      .join(' ');
    try {
      this.replace('session', session.id, session.title, keywords);
    } catch (e) {
      log.warn('SearchService: upsertSession failed', { sessionId: session.id, error: String(e) });
    }
  }

  /**
   * FTS5 has no key to replace on: an item's row is deleted before it is written again. The table's `project_id`
   * column is left null (@@@c1-legacy-project: dropped with the projects table next release).
   */
  private replace(itemType: SearchItemKind, itemId: string, title: string, keywords: string): void {
    sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM search_index WHERE item_id = ? AND item_type = ?').run(itemId, itemType);
      sqlite.prepare('INSERT INTO search_index(item_type, item_id, title, keywords) VALUES (?, ?, ?, ?)')
        .run(itemType, itemId, title, keywords);
    })();
  }

  private removeByType(itemType: string, itemId: string): void {
    try {
      sqlite
        .prepare(`DELETE FROM search_index WHERE item_id = ? AND item_type = ?`)
        .run(itemId, itemType);
    } catch (e) {
      log.warn('SearchService: removeByType failed', { itemType, itemId, error: String(e) });
    }
  }

  private backfill(): void {
    try {
      const count = (
        sqlite.prepare(`SELECT count(*) as n FROM search_index`).get() as { n: number }
      ).n;

      if (count > 0) return;

      const allSessions = db
        .select({
          id: sessions.id,
          config: sessions.config,
          archivedAt: sessions.archivedAt,
          linkedIssue: sessions.linkedIssue,
          branchName: workspaces.branchName,
        })
        .from(sessions)
        .leftJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
        .all()
        .filter((c) => !c.archivedAt);

      const upsertStmt = sqlite.prepare(
        `INSERT INTO search_index(item_type, item_id, title, keywords)
         VALUES (?, ?, ?, ?)`
      );

      // Names as they read now: boot loads the roster projection before the search index, and every later
      // name change arrives as `session:renamed` and is reindexed above.
      sqlite.transaction(() => {
        for (const c of allSessions) {
          const keywords = [c.branchName, c.linkedIssue?.identifier, c.linkedIssue?.title].filter(Boolean).join(' ');
          upsertStmt.run('session', c.id, taskName(c), keywords);
        }
      })();

      log.info('SearchService: backfilled search index', {
        sessions: allSessions.length,
      });
    } catch (e) {
      log.warn('SearchService: backfill failed', { error: String(e) });
    }
  }
}

export const searchService = new SearchService();
