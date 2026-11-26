import { ptyTurnEnds } from '../sessions/pty-turn-ends';
import type { IndexSource } from '../session-index/worker';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { readProjects } from '@main/core/projects/operations/getProjects';
import { resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import {
  type SessionpageProjectSummary,
  type SessionpageSessionSummary,
} from '@gugu/session-core/session-record';
import { getPlugin, isValidProviderId } from '@main/core/agents/plugin-registry';
import { db } from '@main/db/client';
import { sessions, projects, type SessionRow } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { locateSessionRecord, sessionRecordHarnessForProvider, type SessionRecordLocation } from './locate';
import { journalHasTurns, journalLocator } from '../sessions/session-journal';
import { knownHarnessConfigRoots } from '@main/core/agent-hooks/harness-config-roots';

/** 会话行 → 记录在哪:读行、判运行时、找这条会话的记录与索引源。 */

// ─── 会话行 ────────────────────────────────────────────────────────────────

/**
 * 取**整行**（不是手搓投影）：写侧要的是一个真的 `Conversation`。
 * 早先这里只选了列表要显示的那几列，再把它 `as Conversation` 递给注入路径 —— 那是一句
 * 类型上的谎：注入路径哪天多读一个字段，拿到的是 undefined 而类型说它在，静默走错。
 */
export function readSessionRows(includeArchived = false, where?: SQL, limit?: number): Array<{
  session: SessionRow;
  project: SessionpageProjectSummary;
}> {
  return db
    .select({
      session: sessions,
      project: { id: projects.id, name: projects.name, path: projects.path, kind: projects.kind },
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    // 归档的会话不上这张面 —— 与 `getSessions()` 同一条口径:归属键是**会话自己**那一列(spec session-graph)。
    .where(and(includeArchived ? undefined : isNull(sessions.archivedAt), where))
    .orderBy(desc(sessions.lastInteractedAt))
    .limit(limit ?? Number.MAX_SAFE_INTEGER)
    .all()
    .map(({ session, project }) => ({ session, project: projectSummary(project) }));
}

export function readLocalProjects(): SessionpageProjectSummary[] {
  return readProjects().map(({ id, name, path, kind }) => projectSummary({ id, name, path, kind }));
}

/** #609 workspace 带上 kind,手机据此把它的会话列进「任务」;项目照旧只有 id / name / path。 */
function projectSummary({ kind, ...project }: { id: string; name: string; path: string; kind?: 'project' | 'workspace' }): SessionpageProjectSummary {
  return kind === 'workspace' ? { ...project, kind } : project;
}

export function readSessionRow(conversationId: string, options: { includeArchived?: boolean } = {}): SessionRow | null {
  return (
    readSessionRows(options.includeArchived, eq(sessions.id, conversationId)).find((row) => row.session.id === conversationId)?.session ?? null
  );
}

/**
 * 这条会话的终端提问能不能从提问卡回答:终端腿,且这家声明了关掉选择器的取消键(#6798、#7035)。
 * **只在这里判**:能 ⇒ 提问结算带上 `questions`,之后手机画不画表单、写侧收不收都只看有没有 `questions`。
 */
export function remoteAnswerFor(row: SessionRow): boolean {
  if (summaryRuntime(row.runtime) !== 'pty' || !row.provider || !isValidProviderId(row.provider)) return false;
  const plugin = getPlugin(row.provider);
  return Boolean(plugin.capabilities.sessionBundle.sessionTuiQuestionAnswer);
}

/**
 * `runtime` 列为空时按 'pty' 读 —— 与 `mapSessionRowToSession` 同一条既有约定
 * （这一列是后加的，存量行为空且它们全是终端腿）。'acp'/'pty' 之外（今天是 'node'）如实报 unknown。
 */
export function summaryRuntime(runtime: string | null): SessionpageSessionSummary['runtime'] {
  if (runtime === 'acp') return 'acp';
  if (runtime === 'pty' || runtime === null) return 'pty';
  return 'unknown';
}

/**
 * 这一家有没有咕咕托管的配置根。今天三家都是 `injectionMode: 'runtime'` ⇒ 恒为 null；
 * 声明自相矛盾时 `resolveAgentHome` 会抛 —— 那是**这一家的** descriptor 有问题，
 * 只让这一条会话变成 unsupported，❌ 不许把整张列表带走。
 */
function managedConfigRootFor(providerId: string | null): {
  root: string | null;
  problem: string | null;
} {
  const id = providerId?.trim();
  if (!id) return { root: null, problem: null };
  try {
    const bundle = getPlugin(id).capabilities.sessionBundle;
    const home = resolveAgentHome({
      providerId: id,
      injectionMode: bundle.injectionMode,
      configRoot: bundle.configRoot,
      guguHome: process.env.GUGU_HOME ?? '',
      osHomeDir: process.env.HOME ?? '',
      sourceEnv: process.env,
    });
    return { root: home?.configRoot ?? null, problem: null };
  } catch (error) {
    return { root: null, problem: (error as Error)?.message ?? String(error) };
  }
}

/**
 * 会话所绑订阅连接的配置根解析器(宿主注入,与 `setSessionTimelineFactory` 同一个理由:
 * 真实现拖 electron `app` 与 db,服务层要保持能在任何 node 环境下测)。没注入 ⇒ 只在默认根里找。
 */
export type ConnectionConfigRootResolver = (providerId: string, connectionId: string) => string | null;

let connectionConfigRootOf: ConnectionConfigRootResolver | null = null;

export function setConnectionConfigRootResolver(next: ConnectionConfigRootResolver | null): void {
  connectionConfigRootOf = next;
}

/**
 * 单一目录之前(#26),非原生连接上的会话跑在连接自己的配置根上,记录写在那里;开机时已搬进用户根,
 * 之后的新内容只长在用户根里。所以连接根只排在默认根后面兜底(搬失败的那几条),❌ 排前面 —— 那样读到的是搬家时的旧副本。
 */
function connectionRootFor(row: SessionRow): string | null {
  const connectionId = pinnedConnectionId(row);
  if (!row.provider || !connectionId) return null;
  try {
    return connectionConfigRootOf?.(row.provider, connectionId) ?? null;
  } catch (error) {
    // 解析不出来只让这一条退回默认根,❌ 不许把整张会话列表带走(与 `managedConfigRootFor` 同一条理由)。
    log.warn('sessionTimeline: 连接配置根解析失败,改在默认根里找', { sessionId: row.id, error: String(error) });
    return null;
  }
}

/**
 * 会话绑的连接。绑定是启动时才落的 —— 外部 fork 出来的行(终端里 `/fork`)还没启动过就没有,
 * 而它的记录已经在源会话那条连接的根里了 ⇒ 顺着 `forkedFrom` 找最近一个落了绑定的祖先
 * (与 `resolveHarnessConnection` 继承的是同一条链)。
 */
function pinnedConnectionId(row: SessionRow): string | undefined {
  const seen = new Set<string>();
  let current: SessionRow | null = row;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const pinned = current.config?.subscriptionConnectionId;
    if (pinned) return pinned;
    const parentId: string | undefined = current.config?.forkedFrom?.sessionId;
    current = parentId ? readSessionRow(parentId) : null;
  }
  return undefined;
}

export function locateRow(row: SessionRow, managedOnly = false): SessionRecordLocation {
  const managed = managedConfigRootFor(row.provider);
  if (managed.problem) return { supported: false, reason: managed.problem };
  const legacy = managedOnly && managed.root ? null : connectionRootFor(row);
  return locateSessionRecord({
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    managedConfigRoot: managed.root,
    managedOnly: managedOnly && !!managed.root,
    // 这一家在本机 hook 里报过的配置目录(包装器在进程里改过的那种)排在默认根之后一起找。
    fallbackConfigRoots: [...(legacy ? [legacy] : []), ...knownHarnessConfigRoots(row.provider)],
  });
}

/** Its agent keeps no record gugu reads, and gugu's journal has its turns. */
export function journalOnly(row: SessionRow): boolean {
  return summaryRuntime(row.runtime) === 'acp' && sessionRecordHarnessForProvider(row.provider) === null && journalHasTurns(row.id);
}

/** The session has a record to read by now: a stand-in for it gives way to the timeline of that record. */
export function recordReadable(conversationId: string): boolean {
  const row = readSessionRow(conversationId);
  return row !== null && (locateRow(row).supported || journalOnly(row));
}

export function indexSource(row: SessionRow, location: SessionRecordLocation): IndexSource {
  const locator = location.supported ? location.locator : null;
  const acp = summaryRuntime(row.runtime) === 'acp';
  return {
    locator,
    journal: acp && journalHasTurns(row.id) ? journalLocator(row.id) : null,
    ...(!acp && locator ? { hostEnds: ptyTurnEnds(row.id, locator.providerSessionId).read() } : {}),
  };
}
