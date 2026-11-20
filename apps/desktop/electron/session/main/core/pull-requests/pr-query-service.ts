import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import {
  pullRequestAssignees,
  pullRequestChecks,
  pullRequestLabels,
  pullRequests,
  pullRequestUsers,
} from '@main/db/schema';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { assemblePullRequest, pullRequestRepositoryScope, type PrRow } from './pr-utils';

async function fetchRelated(rows: PrRow[]): Promise<PullRequest[]> {
  if (rows.length === 0) return [];

  const urls = rows.map((r) => r.url);

  const [labelRows, assigneeJoins, checkRows] = await Promise.all([
    db.select().from(pullRequestLabels).where(inArray(pullRequestLabels.pullRequestId, urls)),
    db
      .select({
        pullRequestUrl: pullRequestAssignees.pullRequestUrl,
        user: pullRequestUsers,
      })
      .from(pullRequestAssignees)
      .innerJoin(pullRequestUsers, eq(pullRequestAssignees.userId, pullRequestUsers.userId))
      .where(inArray(pullRequestAssignees.pullRequestUrl, urls)),
    db.select().from(pullRequestChecks).where(inArray(pullRequestChecks.pullRequestUrl, urls)),
  ]);

  // Collect all author user IDs
  const authorIds = [
    ...new Set(rows.map((r) => r.authorUserId).filter((id): id is string => id !== null)),
  ];
  const authorMap = new Map<string, typeof pullRequestUsers.$inferSelect>();
  if (authorIds.length > 0) {
    const authors = await db
      .select()
      .from(pullRequestUsers)
      .where(inArray(pullRequestUsers.userId, authorIds));
    for (const a of authors) authorMap.set(a.userId, a);
  }

  const labelsByUrl = new Map<string, (typeof pullRequestLabels.$inferSelect)[]>();
  for (const l of labelRows) {
    const arr = labelsByUrl.get(l.pullRequestId) ?? [];
    arr.push(l);
    labelsByUrl.set(l.pullRequestId, arr);
  }

  const assigneesByUrl = new Map<string, (typeof pullRequestUsers.$inferSelect)[]>();
  for (const a of assigneeJoins) {
    const arr = assigneesByUrl.get(a.pullRequestUrl) ?? [];
    arr.push(a.user);
    assigneesByUrl.set(a.pullRequestUrl, arr);
  }

  const checksByUrl = new Map<string, (typeof pullRequestChecks.$inferSelect)[]>();
  for (const c of checkRows) {
    const arr = checksByUrl.get(c.pullRequestUrl) ?? [];
    arr.push(c);
    checksByUrl.set(c.pullRequestUrl, arr);
  }

  return rows.map((row) =>
    assemblePullRequest(
      row,
      row.authorUserId ? (authorMap.get(row.authorUserId) ?? null) : null,
      labelsByUrl.get(row.url) ?? [],
      assigneesByUrl.get(row.url) ?? [],
      checksByUrl.get(row.url) ?? []
    )
  );
}

export class PrQueryService {
  async getSessionPullRequests(sessionBranch: string, repositoryUrl: string): Promise<PullRequest[]> {
    const rows = await db
      .select()
      .from(pullRequests)
      .where(
        and(eq(pullRequests.headRefName, sessionBranch), pullRequestRepositoryScope([repositoryUrl]))
      );

    return fetchRelated(rows);
  }
}

export const prQueryService = new PrQueryService();
