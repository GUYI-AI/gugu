import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, projects, workspaces } from '@main/db/schema';
import { hasLocalSessionSource, getLocalSessionSource } from '@main/core/session-import/host-source';
import { machineOutwardProjectIds } from '@main/core/projects/project-public-id';
import type { SessionRuntime } from '@shared/core/sessions/sessions';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import {
  LOCAL_SESSION_ENGINE_PROVIDER,
  type ListLocalSessionsResult,
  type LocalSessionRow,
} from '@shared/core/session-import/session-import';
import {
  SESSION_HISTORY_SOURCES,
  SESSION_HISTORY_STATUSES,
  SESSION_HOME_SECTION_KEY,
  compareSessionHistoryRows,
  compareSessionHistorySections,
  displaySessionTitle,
  matchesSessionHistoryFilters,
  projectSectionKey,
  type SessionHistoryDirectoryPage,
  type SessionHistoryDirectoryParams,
  type SessionHistoryDirectoryRow,
  type SessionHistoryPage,
  type SessionHistoryParams,
  type SessionHistoryRow,
} from '@shared/core/session-history/session-history';
import { sessionParentId } from '@main/core/sessions/utils';
import { taskName } from '@main/core/sessions/task-name';
import { createLocalGroupOf } from './local-session-group';

// spec session-page「会话历史」(#6083):把咕咕自己的会话(活跃 + 已归档)与本机引擎磁盘上还没导入的会话
// 合成**一张表**,筛 / 排全在这里做完再切页;目录视图(默认)= 同一份筛选结果按节聚合 —— 在项目群里的按
// 账号项目(`project:<群>`),别的按目录 —— 每节随行带回头几条会话。筛与排的函数在 @shared,渲染层归并几台机器时用同一份。
//
// 为什么不在渲染层排:本机索引是分轮的(cached 首帧 → fresh 多轮,见 use-session-history),只对
// 「当前已索引的那 200 条」排序,索引没走完时给出的「最早 / 最晚」是错的。这里向索引要**全量已索引行**
// (不切页),与库表合并后再排、再切 —— 索引仍可能没走完,但那由 `local.pending` 原样透出,渲染层照旧
// 显示进度,而不是拿半截索引冒充全集。
//
// 账号边界:这里读的是与侧栏同一张 `conversations` 表(同一个库、同一份可见域),只是**不再**滤掉
// `archived_at`;本机引擎原件同机人人可读(product spec 明写的边界)。
// ❌ 没有借「统一」多露出任何别的账号的咕咕会话。

const DEFAULT_LIMIT = 200;

/**
 * SQLite `CURRENT_TIMESTAMP` 落的是 `YYYY-MM-DD HH:MM:SS`(UTC、无时区标记);渲染层写回的字段
 * (如 `last_interacted_at`)是 ISO 串。两种都认;认不出的当「没有」而不是 NaN 参与排序。
 */
export function toEpochMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const raw = text.trim();
  if (!raw) return null;
  const normalized = /[TZ+]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

type GuguJoinedRow = {
  session: typeof sessions.$inferSelect;
  projectName: string;
  projectPath: string;
  projectKind: 'project' | 'workspace';
  workspacePath: string | null;
};

async function readGuguRows(): Promise<GuguJoinedRow[]> {
  return db
    .select({
      session: sessions,
      projectName: projects.name,
      projectPath: projects.path,
      projectKind: projects.kind,
      workspacePath: workspaces.path,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId));
}

/**
 * 「子会话」= 挂在它下面的,按父会话这条边(`sessionParentId`)递归 —— 与渲染层 `session-descendants.ts`、
 * 归档的 `familyOf`、session_children 同一条规则,fork 不在其中。几处对「谁是子会话」必须给同一个答案。
 */
function countDescendants(rows: GuguJoinedRow[]): Map<string, number> {
  const childrenOf = new Map<string, string[]>();
  for (const { session } of rows) {
    const parent = sessionParentId(session);
    if (!parent || parent === session.id) continue;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session.id]);
  }
  const counts = new Map<string, number>();
  for (const { session } of rows) {
    const seen = new Set<string>();
    const queue = [session.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (child === session.id || seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    counts.set(session.id, seen.size);
  }
  return counts;
}

function toGuguRow(
  joined: GuguJoinedRow,
  titles: Map<string, string>,
  descendants: Map<string, number>
): SessionHistoryRow {
  const { session } = joined;
  const standalone = isImplicitSessionHomeProjectId(session.projectId);
  const archivedAt = toEpochMs(session.archivedAt);
  const parentId = sessionParentId(session);
  return {
    key: `gugu:${session.id}`,
    source: 'gugu',
    status: archivedAt === null ? 'active' : 'archived',
    title: displaySessionTitle(taskName(session)),
    providerSessionId: session.providerSessionId ?? null,
    providerId: session.provider ?? null,
    // 独立任务住在用户从没见过的 task-home 项目里(spec session-page 任务分区),它的路径不是用户的目录。
    directory: standalone ? null : (joined.workspacePath ?? joined.projectPath),
    projectName: standalone ? null : joined.projectName,
    updatedAt: toEpochMs(session.updatedAt) ?? 0,
    lastPromptAt: toEpochMs(session.lastInteractedAt),
    addedAt: toEpochMs(session.createdAt),
    archivedAt,
    childCount: descendants.get(session.id) ?? 0,
    parentTitle: parentId ? (titles.get(parentId) ?? null) : null,
    gugu: {
      projectId: session.projectId,
      sessionId: session.id,
      runtime: (session.runtime as SessionRuntime | null) ?? 'pty',
    },
  };
}

function toLocalRow(local: LocalSessionRow): SessionHistoryRow {
  return {
    key: `local:${local.filePath}`,
    source: local.engine,
    status: 'not-imported',
    title: displaySessionTitle(local.title),
    providerSessionId: local.providerSessionId,
    providerId: LOCAL_SESSION_ENGINE_PROVIDER[local.engine] ?? null,
    directory: local.cwd,
    projectName: null,
    updatedAt: local.updatedAt,
    lastPromptAt: local.updatedAt,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    local,
  };
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

type Collected = {
  /** 命中筛选的会话,尚未排序。 */
  matching: SessionHistoryRow[];
  countsBySource: Record<SessionHistoryRow['source'], number>;
  countsByStatus: Record<SessionHistoryRow['status'], number>;
  directories: SessionHistoryPage['directories'];
  local: SessionHistoryPage['local'];
  /** 这一行归哪一节:项目群里的项目 → `project:<群>`;别的项目 → 项目路径;不在任何项目下的 → 它的仓库 / 目录;没有目录为 null。 */
  groupOf: (row: SessionHistoryRow) => { key: string | null; projectName: string | null };
};

/** 两种视图共用的前半段:读库 + 读索引 → 合并去重 → 计数 → 筛选。排序 / 聚合 / 切页由调用方做。 */
async function collect(params: SessionHistoryParams): Promise<Collected> {
  const [guguJoined, localProjects, outward, localPage] = await Promise.all([
    readGuguRows(),
    db.select({ projectId: projects.id, projectPath: projects.path, projectName: projects.name }).from(projects),
    machineOutwardProjectIds(),
    hasLocalSessionSource()
      ? getLocalSessionSource().list({
          // 全量:排序要在合并之后做,切页之前的任何截断都会把「最早」截没。
          limit: Number.MAX_SAFE_INTEGER,
          mode: params.mode,
          hydrateBudgetMs: params.hydrateBudgetMs,
        })
      : Promise.resolve<ListLocalSessionsResult | null>(null),
  ]);

  const titles = new Map(guguJoined.map(({ session }) => [session.id, taskName(session)]));
  const descendants = countDescendants(guguJoined);
  const guguRows = guguJoined.map((joined) => toGuguRow(joined, titles, descendants));

  // 已经导入过的本机会话不再算「未导入」:它在咕咕这边有一行(活跃或已归档),那一行就是它。
  // 匹配同 `importLocalSession` 的去重口径(`sessions.provider_session_id`);claude 导入还用原会话 id 当
  // conversation id,一并认。
  const imported = new Set<string>();
  for (const { session } of guguJoined) {
    imported.add(session.id);
    if (session.providerSessionId) imported.add(session.providerSessionId);
  }
  const localRows = (localPage?.rows ?? [])
    .filter((local) => !imported.has(local.providerSessionId))
    .map(toLocalRow);

  const all = [...guguRows, ...localRows];

  // 本机行没有咕咕项目,按「它所在的 git 仓库」归节(同一仓库的子目录、worktree 并成一节);不在仓库里的按目录本身。
  // 本机的项目(有没有任务都算)只收**它自己那个仓库之内**的原件:项目路径是 cwd 或 cwd 的上级,且不高出 cwd 所在仓库的根
  // (不在仓库里时 = 就是 cwd 本身)。❌ 纯前缀匹配 —— 一个路径是 /Users 的项目会把它底下几千条原件全吞掉
  // (mac1 2026-09-24 读数:一节 3424 条)。
  const localGroupOf = createLocalGroupOf(localProjects);
  // 项目路径在本机唯一(idx_projects_path):原件归到的那个项目路径就认得出是哪个项目。
  const projectAtPath = new Map(localProjects.map((project) => [project.projectPath, project.projectId]));
  // 一个账号项目一节(设计同事 2026-09-23 参照页:节名是「gugu」,❌ 每个 worktree 目录各一节):项目是账号级的,
  // 本机项目在哪个项目群里,这一行就进那个群的节 —— 同一个群的几个本机项目、几台机器上的这个项目都并成一节。
  // 不在项目群里的本机项目按它的路径一节。
  const projectGroup = (projectId: string, path: string, name: string | null) => {
    const chatId = outward(projectId);
    return { key: chatId ? projectSectionKey(chatId) : path, projectName: name };
  };
  const sessionHomeGroup = { key: SESSION_HOME_SECTION_KEY, projectName: null };
  // 咕咕行直接认它自己的项目(工作区 worktree 常常不在项目路径之下,按前缀猜会猜丢);独立任务与任务工作区
  // (#609 workspace:咕咕为自己的需要记的目录,不是项目)进任务那一节。本机行按仓库归,落在项目文件夹里的认那个项目。
  const guguGroupOf = new Map(
    guguJoined.map((j) => [
      `gugu:${j.session.id}`,
      isImplicitSessionHomeProjectId(j.session.projectId) || j.projectKind === 'workspace'
        ? sessionHomeGroup
        : projectGroup(j.session.projectId, j.projectPath, j.projectName),
    ])
  );
  const groupOf = (row: SessionHistoryRow): { key: string | null; projectName: string | null } => {
    const gugu = guguGroupOf.get(row.key);
    if (gugu) return gugu;
    const local = localGroupOf(row.directory);
    const projectId = local.key === null ? undefined : projectAtPath.get(local.key);
    return projectId && local.key !== null
      ? projectGroup(projectId, local.key, local.label)
      : { key: local.key, projectName: local.label };
  };

  const countsBySource = emptyCounts(SESSION_HISTORY_SOURCES);
  const countsByStatus = emptyCounts(SESSION_HISTORY_STATUSES);
  const directoryCounts = new Map<string | null, { projectName: string | null; count: number }>();
  for (const row of all) {
    countsBySource[row.source] += 1;
    countsByStatus[row.status] += 1;
    // 项目下拉的候选跟着「类型 / 状态」走:默认只看咕咕会话时,❌ 把本机几千条原件的 /tmp 目录列进下拉。
    if ((params.source && row.source !== params.source) || (params.status && row.status !== params.status)) continue;
    const group = groupOf(row);
    const entry = directoryCounts.get(group.key) ?? { projectName: group.projectName, count: 0 };
    entry.count += 1;
    directoryCounts.set(group.key, entry);
  }
  const directories = [...directoryCounts]
    .map(([directory, { projectName, count }]) => ({ directory, projectName, count }))
    // 全部列出(项目下拉可搜索,❌ 只给条数最多的前 N 个 —— 剩下的就再也选不到)。
    .sort((a, b) => b.count - a.count || (a.directory ?? '').localeCompare(b.directory ?? ''));

  const matching = all.filter(
    (row) =>
      matchesSessionHistoryFilters(row, params) &&
      (params.directory === undefined ? true : groupOf(row).key === params.directory)
  );

  return {
    matching,
    countsBySource,
    countsByStatus,
    directories,
    local: localPage
      ? {
          discovered: localPage.discovered,
          indexed: localPage.indexed,
          pending: localPage.pending,
          stale: localPage.stale,
        }
      : null,
    groupOf,
  };
}

/** 平铺视图(也是「只看某目录」那一节的读法):筛选 → 排序 → 切页,一会话一行。 */
export async function listSessionHistory(params: SessionHistoryParams = {}): Promise<SessionHistoryPage> {
  const sort = params.sort ?? 'updated';
  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  const { matching, countsBySource, countsByStatus, directories, local } = await collect(params);
  const sorted = matching.sort(compareSessionHistoryRows(sort));
  return {
    // 切页在排序**之后**:第 n 页就是全集里排好序的那一截,❌ 先切再排。
    rows: sorted.slice(offset, offset + limit),
    matched: sorted.length,
    countsBySource,
    countsByStatus,
    directories,
    local,
  };
}

/**
 * 目录视图(默认):筛选 → 按节聚合 → 排序 → 切页,一节一行(节 = `collect` 的 groupOf),每节随行带回头 `sessionsPerDirectory` 条。
 * 聚合在筛选**之后**:节头的计数就是「这个目录里符合当前筛选的有几条」,节内看到的与数字一致。
 * 没有目录的会话(独立任务 / 读不出 cwd 的原件)拢成 key 为 '' 的一节,展开时用 `directory: null` 取。
 */
export async function listSessionHistoryDirectories(
  params: SessionHistoryDirectoryParams = {}
): Promise<SessionHistoryDirectoryPage> {
  const sort = params.sort ?? 'updated';
  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? 0;
  const perDirectory = params.sessionsPerDirectory ?? 0;
  const { matching, countsBySource, countsByStatus, directories, local, groupOf } = await collect(params);

  const buckets = new Map<string | null, SessionHistoryDirectoryRow>();
  for (const row of matching) {
    const group = groupOf(row);
    let bucket = buckets.get(group.key);
    if (!bucket) {
      bucket = {
        key: group.key ?? '',
        directory: group.key,
        projectName: group.projectName,
        sessionCount: 0,
        countsBySource: emptyCounts(SESSION_HISTORY_SOURCES),
        countsByStatus: emptyCounts(SESSION_HISTORY_STATUSES),
        providers: [],
        updatedAt: 0,
        lastPromptAt: null,
        addedAt: null,
        sessions: [],
      };
      buckets.set(group.key, bucket);
    }
    bucket.sessionCount += 1;
    bucket.countsBySource[row.source] += 1;
    bucket.countsByStatus[row.status] += 1;
    bucket.updatedAt = Math.max(bucket.updatedAt, row.updatedAt);
    bucket.lastPromptAt = maxOf(bucket.lastPromptAt, row.lastPromptAt);
    bucket.addedAt = maxOf(bucket.addedAt, row.addedAt);
    if (row.providerId && !bucket.providers.includes(row.providerId)) bucket.providers.push(row.providerId);
    // 先全收,排完再截:头 N 条必须是**排好序**的头 N 条。
    bucket.sessions.push(row);
  }

  const byRow = compareSessionHistoryRows(sort);
  const sorted = [...buckets.values()]
    .sort(compareSessionHistorySections(sort))
    .slice(offset, offset + limit)
    .map((bucket) => ({ ...bucket, sessions: perDirectory > 0 ? bucket.sessions.sort(byRow).slice(0, perDirectory) : [] }));
  return {
    rows: sorted,
    matched: buckets.size,
    countsBySource,
    countsByStatus,
    directories,
    local,
  };
}
