import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { PURGE_HISTORY_BATCH } from '@gugu/core/cloud/agentIdentityRemoval';
import { db } from '@main/db/client';
import { activityEvents, activitySessionProjects, kv, projects, sessionModelSources, sessions, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import type { ArchivedSessionRef, PermanentDeleteFailure, PermanentDeleteOutcome } from '@shared/core/sessions/sessions';
import { managedAgentHome } from '../agents/agent-homes';
import { publishProjectVisibility } from '../projects/operations/project-visibility';
import { dropTimelineArchive } from '../session-timeline/archive-store';
import { viewStateService } from '../view-state/view-state-service';
import { archiveOneLocked } from './archiveSession';
import { sessionWasPermanentlyDeleted, tombstoneDeletedSession } from './fork-capture';
import { forgetSessionPlatformModel } from './platform-model-selection';
import { serializeSessionArchival, sessionArchivalState } from './session-archival';
import { sessionEvents } from './session-events';
import { familyOf } from './session-family';
import { sessionIdentityHost, type SessionIdentityHost } from './session-identity-host';
import { dropJournal } from './session-journal';
import { forgetSessionOutputs } from './session-outputs';

/** One call deletes at most this many named sessions; the renderer drives larger selections batch by batch. */
export const PERMANENT_DELETE_BATCH = 50;

type Row = ArchivedSessionRef & { identities: string[] };
type Problem = { ref: ArchivedSessionRef; reason: PermanentDeleteFailure; error?: unknown };

/**
 * owner 2026-11-26「已归档 → 永久删除」:只删**已归档**的行,先云端、后本机。
 *
 * - 一次最多 50 条(owner 00:58 大批量):渲染侧一批一批调,批与批之间能停,停下时已经删掉的就删掉了、没轮到的原样。
 *   每一条各自一个小事务,条与条之间让出事件循环,主进程不卡。
 * - `withChildren`:这台机器上它名下**已归档**的子会话一起删(叶子先)。还在用的子会话不动(父边被外键清掉,成了顶层)。
 *   别的机器不报已归档的行,所以那边的已归档子会话这里看不见;别的机器上的行由渲染侧直接调那台机器的这个方法。
 * - 云端:还没移出身份的先移出(`archive_user(true)`,与归档同一条路);再把这条会话名下每一个被移除过的身份的
 *   私聊历史删掉(≤50 个一次)。身份行留作墓碑,群里的消息保留、发送者显示「已移除」。云端没回执 = 这一条本机什么都不动。
 * - 本机:会话行(外键带走终端、输入、待发、搜索索引)、活动、模型来源、归档区间与拒投记录、模型选择、产出、页签状态、
 *   咕咕日志、时间线缓存、咕咕托管配置根里的引擎记录(用户自己的 ~/.claude ~/.codex ❌ 碰)、它给自己排的定时、
 *   只剩它在用的工作区行(目录 ❌ 删)。用量时长保留(那天跑过的时长仍是事实,见 schema)。
 * - 一条没删成写进 `failed`(闭集原因),不拦别的;异常原文连同会话和机器只进这台机器的日志。输入不对才抛。
 */
export async function permanentlyDeleteSessions(
  targets: ArchivedSessionRef[],
  options: { withChildren?: boolean } = {}
): Promise<PermanentDeleteOutcome> {
  if (!Array.isArray(targets) || targets.some((target) => !target || typeof target.projectId !== 'string' || !target.projectId
    || typeof target.sessionId !== 'string' || !target.sessionId)) {
    throw new Error('permanentlyDeleteSessions takes [{ projectId, sessionId }]');
  }
  if (targets.length > PERMANENT_DELETE_BATCH) throw new Error(`permanentlyDeleteSessions takes at most ${PERMANENT_DELETE_BATCH} sessions per call`);
  if (options.withChildren !== undefined && typeof options.withChildren !== 'boolean') throw new Error('withChildren must be a boolean');

  const outcome: PermanentDeleteOutcome = { deleted: [], unreached: [], failed: [] };
  const problems: Problem[] = [];
  const fail = (ref: ArchivedSessionRef, reason: PermanentDeleteFailure, error?: unknown) => {
    outcome.failed.push({ projectId: ref.projectId, sessionId: ref.sessionId, reason });
    problems.push({ ref, reason, error });
  };

  // 1. 要删哪些行:点名的,加上(勾了时)它们名下已归档的子会话,叶子先;重复的只算一次。
  const order: ArchivedSessionRef[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const row = db.select({ archivedAt: sessions.archivedAt }).from(sessions)
      .where(and(eq(sessions.id, target.sessionId), eq(sessions.projectId, target.projectId))).get();
    if (!row) {
      // Idempotent: a row this path already deleted is reported deleted again; one that was never here is not.
      if (sessionWasPermanentlyDeleted(target.sessionId) && !seen.has(target.sessionId)) {
        seen.add(target.sessionId);
        outcome.deleted.push({ projectId: target.projectId, sessionId: target.sessionId });
      } else if (!seen.has(target.sessionId)) fail(target, 'not_found');
      continue;
    }
    if (!row.archivedAt) { fail(target, 'not_archived'); continue; }
    if (options.withChildren) {
      const { members, unreached } = await familyOf(target.sessionId, { includeArchived: true });
      outcome.unreached.push(...unreached);
      for (const member of members) {
        if (member.deviceId !== null || seen.has(member.id)) continue;
        const child = db.select({ archivedAt: sessions.archivedAt }).from(sessions).where(eq(sessions.id, member.id)).get();
        if (!child?.archivedAt) continue;
        seen.add(member.id);
        order.push({ projectId: member.projectId, sessionId: member.id });
      }
    }
    if (seen.has(target.sessionId)) continue;
    seen.add(target.sessionId);
    order.push(target);
  }

  // 2. 云端,第一步:每条的身份都已移出,并记下要删私聊历史的全部身份。
  let host: SessionIdentityHost;
  try {
    host = sessionIdentityHost();
  } catch (error) {
    for (const ref of order) fail(ref, 'cloud_unconfirmed', error);
    await logProblems(problems, null);
    return outcome;
  }
  const ready: Row[] = [];
  for (const ref of order) {
    try {
      const identities = await serializeSessionArchival(ref.sessionId, async () => {
        if (!sessionArchivalState(ref.sessionId)?.removedIdentity) await archiveOneLocked(ref.projectId, ref.sessionId, false, true);
        const current = sessionArchivalState(ref.sessionId)?.removedIdentity ?? null;
        if (host.historyIdentities) return host.historyIdentities(ref.sessionId, current);
        if (current) throw new Error('This host cannot delete the task\'s cloud history');
        return [];
      });
      ready.push({ ...ref, identities });
    } catch (error) {
      fail(ref, 'cloud_unconfirmed', error);
    }
    await yieldToLoop();
  }

  // 3. 云端,第二步:私聊历史,≤50 个身份一次。一批失败,只牵连身份在那一批里的行。
  const purged = new Set<string>();
  const failedIds = new Map<string, unknown>();
  const allIds = [...new Set(ready.flatMap((row) => row.identities))];
  for (let start = 0; start < allIds.length; start += PURGE_HISTORY_BATCH) {
    const chunk = allIds.slice(start, start + PURGE_HISTORY_BATCH);
    try {
      if (!host.purgeHistory) throw new Error('This host cannot delete the task\'s cloud history');
      for (const id of await host.purgeHistory(chunk)) purged.add(id);
      for (const id of chunk) if (!purged.has(id)) failedIds.set(id, new Error('The cloud did not confirm deleting this task\'s history'));
    } catch (error) {
      for (const id of chunk) failedIds.set(id, error);
    }
  }

  // 4. 本机:云端都确认了的行,一条一个小事务,条与条之间让出事件循环。
  for (const row of ready) {
    const missing = row.identities.find((id) => !purged.has(id));
    if (missing) { fail(row, 'cloud_unconfirmed', failedIds.get(missing)); continue; }
    try {
      const result = await serializeSessionArchival(row.sessionId, () => deleteLocalSession(row));
      if (result !== 'restored') outcome.deleted.push({ projectId: row.projectId, sessionId: row.sessionId });
      else fail(row, 'restored');
    } catch (error) {
      fail(row, 'failed', error);
    }
    await yieldToLoop();
  }
  await logProblems(problems, host);
  return outcome;
}

/** The receipt carries only the closed reason; the raw error goes to this machine's log, with the session and the machine. */
async function logProblems(problems: Problem[], host: SessionIdentityHost | null): Promise<void> {
  if (!problems.length) return;
  const deviceId = host?.attachmentCreationContext
    ? await host.attachmentCreationContext().then((context) => context.deviceId, () => null)
    : null;
  for (const { ref, reason, error } of problems) {
    log.warn('permanentlyDeleteSessions: a session was not deleted', {
      sessionId: ref.sessionId, projectId: ref.projectId, deviceId, reason,
      ...(error === undefined ? {} : { error: String(error) }),
    });
  }
}

/** Caller holds serializeSessionArchival. 'restored' = restored since the cloud step; 'gone' = a concurrent call deleted it. */
async function deleteLocalSession(ref: ArchivedSessionRef): Promise<'deleted' | 'gone' | 'restored'> {
  const row = db.select().from(sessions).where(and(eq(sessions.id, ref.sessionId), eq(sessions.projectId, ref.projectId))).get();
  if (!row) return sessionWasPermanentlyDeleted(ref.sessionId) ? 'gone' : 'restored';
  if (!row.archivedAt) return 'restored';
  // Before the row goes: a leftover record (the user's own CLI file, a file rm could not remove) must not come back as an
  // "external fork" — not even after a restart.
  tombstoneDeletedSession([row.id, row.providerSessionId]);
  deleteLocalSessionRows(row.id);
  // Lifecycle listeners: the agent's own schedules pointing at it (automations), the search index.
  sessionEvents._emit('session:deleted', row.id);
  await Promise.all([
    forgetSessionPlatformModel(row.id), forgetSessionOutputs(row.id),
    viewStateService.del(`session:${row.id}`), viewStateService.del(`session:${row.id}:tabs`),
  ]);
  if (row.workspaceId) dropWorkspaceRowIfUnused(row.workspaceId);
  // Files are derived or engine records; the row is already gone, so a file that will not go is logged, not a failure.
  const files = await Promise.allSettled([
    dropJournal(row.id), dropTimelineArchive(row.id), dropManagedNativeRecords(row.provider, row.providerSessionId),
  ]);
  for (const file of files) {
    if (file.status === 'rejected') log.warn('permanentlyDeleteSessions: a file was left behind', { sessionId: row.id, error: String(file.reason) });
  }
  events.emit(sessionChangedChannel, { projectId: row.projectId, sessionId: row.id, changes: { archivedAt: row.archivedAt } });
  await publishProjectVisibility(row.projectId);
  return 'deleted';
}

/** The only `.delete(sessions)` in the app (scripts/checks/check-permanent-removal.mts names this function). */
function deleteLocalSessionRows(sessionId: string): void {
  const refusalPrefix = `session-archival-refusal:${sessionId}:`;
  db.transaction((tx) => {
    tx.delete(activityEvents).where(eq(activityEvents.sessionId, sessionId)).run();
    tx.delete(sessionModelSources).where(eq(sessionModelSources.sessionId, sessionId)).run();
    tx.delete(activitySessionProjects).where(eq(activitySessionProjects.sessionId, sessionId)).run();
    tx.delete(kv).where(or(eq(kv.key, `session-archival:${sessionId}`), sql`substr(${kv.key}, 1, ${refusalPrefix.length}) = ${refusalPrefix}`)).run();
    // Foreign keys take terminals, messages, session_pending (+ its source rows) and the search index with it.
    tx.delete(sessions).where(eq(sessions.id, sessionId)).run();
  });
}

/** A workspace row nothing else uses: no other session, not a project's root, not a folder attached to a project. Never the directory. */
function dropWorkspaceRowIfUnused(workspaceId: string): void {
  db.transaction((tx) => {
    if (tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, workspaceId)).limit(1).get()) return;
    if (tx.select({ id: projects.id }).from(projects).where(eq(projects.repositoryWorkspaceId, workspaceId)).limit(1).get()) return;
    tx.delete(workspaces).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.projectId))).run();
  });
}

/**
 * The engine's own records of this session, only inside the config root Gugu manages for that harness (under GUGU_HOME),
 * recognised by the harness's own `historySession` rule. The user's own root (~/.claude, ~/.codex — where an imported
 * session's original lives) is never touched.
 */
export async function dropManagedNativeRecords(provider: string | null, providerSessionId: string | null): Promise<string[]> {
  if (!provider || !providerSessionId) return [];
  const home = managedAgentHome(provider);
  if (!home?.historySession) return [];
  const root = path.resolve(home.configRoot);
  if (root === path.resolve(home.userConfigRoot)) return [];
  const wanted = providerSessionId.toLowerCase();
  const matched: string[] = [];
  for (const top of home.upgradeHistory ?? []) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, top), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const relative = path.posix.join(top, entry.split(path.sep).join('/'));
      if (home.historySession(relative)?.id === wanted) matched.push(relative);
    }
  }
  const removed: string[] = [];
  for (const relative of matched.sort((a, b) => a.length - b.length)) {
    if (removed.some((done) => relative.startsWith(`${done}/`))) continue;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) continue;
    await rm(absolute, { recursive: true, force: true });
    removed.push(relative);
  }
  return removed;
}
