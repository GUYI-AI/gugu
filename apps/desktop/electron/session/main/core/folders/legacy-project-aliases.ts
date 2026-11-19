// @@@legacy-project-aliases — local project ids of earlier releases outlive this database's projects: cloud file
// versions name them (host_project_id), so do task cards, gugu://project/ links, tmux session names and agent-create
// defaults. The C1 migration wrote one row per project; nothing writes after. An id with no row is gone.
import { eq } from 'drizzle-orm';
import { db, type AppDb, type DrizzleTx } from '@main/db/client';
import { legacyProjectAliases } from '@main/db/schema';

/**
 * @@@c1-legacy-project — the previous release requires project_id (NOT NULL, FK to projects) on sessions, terminals and
 * editor buffers: rows written since C1 point at this placeholder project (created by the C1 migration) so a rolled-back
 * build still boots. Dropped with those columns in the cleanup release.
 */
export const LEGACY_PLACEHOLDER_PROJECT_ID = 'c1-placeholder';

export type LegacyProject = { rootWorkspaceId: string | null; chatId: string | null };

export function legacyProject(projectId: string, runner: AppDb | DrizzleTx = db): LegacyProject | undefined {
  const [row] = runner.select({ rootWorkspaceId: legacyProjectAliases.rootWorkspaceId, chatId: legacyProjectAliases.chatId })
    .from(legacyProjectAliases).where(eq(legacyProjectAliases.projectId, projectId)).limit(1).all();
  return row;
}
