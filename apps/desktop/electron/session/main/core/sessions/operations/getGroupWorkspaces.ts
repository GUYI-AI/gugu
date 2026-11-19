import { and, eq, inArray, isNull } from 'drizzle-orm';
import { listFolders } from '@main/core/folders/folders';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import type { ProjectWorkspace } from '@shared/core/workspaces/project-workspace';
import { resolveWorkspaceKind } from '../../workspaces/resolve-workspace-kind';
import { taskName } from '../task-name';

/**
 * The workspaces of a group on this machine (@@@group-folders):
 * - its folders, in the group's order
 * - every other workspace a non-archived session of the group works in (a worktree, a folder since moved away)
 *
 * Deduplicated by workspace id (sessions in one of the group's folders are covered by that folder's entry).
 */
export async function getGroupWorkspaces(groupChatId: string): Promise<ProjectWorkspace[]> {
  const folderIds = listFolders(groupChatId).map((folder) => folder.id);

  // 2. Load all workspaces linked through non-archived sessions for this project,
  //    joining the session title for display purposes.
  const sessionWsRows = await db
    .select({
      wsId: workspaces.id,
      wsKind: workspaces.kind,
      wsType: workspaces.type,
      wsPath: workspaces.path,
      wsBranchName: workspaces.branchName,
      wsConfig: workspaces.config,
      wsLinesAdded: workspaces.linesAdded,
      wsLinesDeleted: workspaces.linesDeleted,
      sessionId: sessions.id,
      sessionConfig: sessions.config,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .where(and(eq(sessions.chatId, groupChatId), isNull(sessions.archivedAt)));

  // 3. The folders themselves, so they are listed even when no session works in them yet.
  const folderRows = folderIds.length
    ? (await db.select().from(workspaces).where(inArray(workspaces.id, folderIds)))
        .sort((a, b) => folderIds.indexOf(a.id) - folderIds.indexOf(b.id))
    : [];

  // 4. Count how many non-archived sessions link to each workspace.
  const wsSessionCount = new Map<string, number>();
  for (const row of sessionWsRows) {
    wsSessionCount.set(row.wsId, (wsSessionCount.get(row.wsId) ?? 0) + 1);
  }

  // 5. Build the result set, deduplicating by workspace ID.
  const seen = new Set<string>();
  const result: ProjectWorkspace[] = [];

  // The group's folders come first.
  for (const repoWsRow of folderRows) {
    seen.add(repoWsRow.id);
    result.push({
      id: repoWsRow.id,
      kind: resolveWorkspaceKind(repoWsRow),
      path: repoWsRow.path,
      branchName: repoWsRow.branchName,
      config: repoWsRow.config,
      linesAdded: repoWsRow.linesAdded,
      linesDeleted: repoWsRow.linesDeleted,
      sessionId: null,
      title: null,
      isLive: !!workspaceRegistry.get(repoWsRow.id),
      linkedSessionCount: wsSessionCount.get(repoWsRow.id) ?? 0,
    });
  }

  for (const row of sessionWsRows) {
    if (seen.has(row.wsId)) continue;
    seen.add(row.wsId);
    result.push({
      id: row.wsId,
      kind: resolveWorkspaceKind({ kind: row.wsKind, type: row.wsType, path: row.wsPath }),
      path: row.wsPath,
      branchName: row.wsBranchName,
      config: row.wsConfig,
      linesAdded: row.wsLinesAdded,
      linesDeleted: row.wsLinesDeleted,
      sessionId: row.sessionId,
      title: taskName({ id: row.sessionId, config: row.sessionConfig }),
      isLive: !!workspaceRegistry.get(row.wsId),
      linkedSessionCount: wsSessionCount.get(row.wsId) ?? 0,
    });
  }

  return result;
}
