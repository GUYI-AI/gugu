import { and, eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings, projects, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { appSettingsService } from '@main/core/settings/settings-service';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { sessionParentId } from './utils';

const MIGRATION_KEY = 'migration.sidebar-pin-upgrade-v1';

/**
 * #2548「Upgrade」(owner decision): the first time this machine runs with the desktop sidebar switch on, every
 * top-level session that is 置顶 inside a project (the Projects tab's Pinned section) is also 固定到左侧栏, so it stays
 * at the top of the one left list. It stays 置顶 too. Standalone pinned sessions need nothing: they are rows of that
 * list already. One-shot like migrate-lifecycle-outbox: the marker is written in the same transaction, so it never
 * runs again and the person's later choices (unpinning one of them) are never undone. Archived ones are included:
 * restored later, they come back where they were.
 */
export function upgradeProjectPinsToSidebarOnce(): Array<{ sessionId: string; projectId: string }> {
  if (db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, MIGRATION_KEY)).limit(1).all().length) {
    return [];
  }

  let marked: Array<{ sessionId: string; projectId: string }> = [];
  db.transaction((tx) => {
    const rows = tx
      .select({ id: sessions.id, projectId: sessions.projectId, parentSessionId: sessions.parentSessionId, config: sessions.config })
      .from(sessions)
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .where(and(eq(sessions.isPinned, 1), eq(sessions.isPinnedToSidebar, 0), eq(projects.kind, 'project')))
      .all();
    // A child is never a row of the left list: only top-level sessions are marked (same rule as setSessionPinnedToSidebar).
    marked = rows.filter((row) => sessionParentId(row) === null).map((row) => ({ sessionId: row.id, projectId: row.projectId }));
    for (const { sessionId } of marked) {
      tx.update(sessions).set({ isPinnedToSidebar: 1, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(sessions.id, sessionId)).run();
    }
    tx.insert(appSettings).values({ key: MIGRATION_KEY, value: new Date().toISOString() }).run();
  });

  for (const { sessionId, projectId } of marked) {
    events.emit(sessionChangedChannel, { sessionId, projectId, changes: { isPinnedToSidebar: true } });
  }
  if (marked.length > 0) log.info('sidebar pin upgrade: project-pinned sessions pinned to the sidebar', { count: marked.length });
  return marked;
}

/**
 * Runs the upgrade once the switch (`interface.desktopSidebarV2`) is on: at startup after the settings service, and
 * whenever the interface settings change (the switch turned on in a running app). Switch off = nothing, no marker.
 */
export async function settleSidebarPinUpgrade(): Promise<number> {
  const { desktopSidebarV2 } = await appSettingsService.get('interface');
  if (!desktopSidebarV2) return 0;
  return upgradeProjectPinsToSidebarOnce().length;
}
