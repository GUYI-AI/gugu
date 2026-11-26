import { buildSessionPermissionOptions } from '@shared/session-permission-options';
import { nativeConversationHistoryFloor } from '../sessions/native-publication-host';
import { clearedHistoryResult, historyClearEpoch } from '@gugu/session-core/session-record/conversation-history-clear';
import { runtimeModelId } from '@gugu/session-core/models/custom-model';
import { turnAnnotationSchema, promptAttachmentSchema, turnFileRefSchema } from '@gugu/session-core/acp/client';
import { SessionInputAdmissionError, sessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission';
import { priorInputAdmission, sameInput, type InputAdmissionPayload } from './input-admission';
import { withdrawAll } from '../asks';
import { resetAsks, respond as respondAsk, respondQuestion as respondAskQuestion } from '../asks/ask';
import { answeredAskOf, readAnsweredAsks, recordAnsweredAsk } from '../asks/answered-asks';
import { askSourceSpec } from '../asks/sources';
import { nativeConversationAliases, nativeConversationUnread, nativeOwnerNotificationUnread } from '../sessions/session-conversation-read';
import { ownerNotificationFile } from '../sessions/owner-notifications';
import { indexedTurnCount, indexSessionRecord, prepareSessionIndex } from '../session-index/session-index';
import { nativeConversationListActivity } from '../sessions/session-conversation-live';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import type { OpenedOutput } from '@gugu/session-core/acp/client';
import {
  type RecordCursor,
  type SessionTimeline,
  type Settlement,
  type SessionpageProjectSummary,
  type SessionpageSessionRespondRequest,
  type SessionpageSessionRespondResult,
  type SessionpageSessionCancelResult,
  type SessionpageSessionUpdateRequest,
  type SessionpageSessionUpdateResult,
  type SessionpageSessionSummary,
  type AnsweredAsk,
  type SessionpageSessionsListResult,
  type SessionpageSessionOptions,
  type SessionpageSessionOptionsRequest,
  type SessionpageSessionsEvent,
  type SessionpageSessionSetOptionRequest,
  type SessionpageSessionReloadModelRequest,
  type SessionpageOpenedFileReadRequest,
  type SessionpageOpenedFileChunk,
  type TimelineAfterResult,
  type TimelineOlderResult,
  type TimelineSnapshot,
} from '@gugu/session-core/session-record';
import { sessionListDelta } from '@gugu/session-core/session-record/session-list-delta';
import { SessionOptionsError, readSessionOptions, setSessionOption } from './live-options';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { sessionParentId, sessionSpawnerId, mapSessionRowToSession } from '@main/core/sessions/utils';
import { sessionBornInChatId } from '@shared/core/sessions/sessions';
import { taskName } from '@main/core/sessions/task-name';
import { agentIdsBySession, sessionAgents } from '@main/core/sessionpage/sessionpage-session-agent';
import { db } from '@main/db/client';
import { sessions, type SessionRow } from '@main/db/schema';
import { persistedWorkspacePath } from '@main/core/projects/utils';
import { events, tapMainEvents } from '@main/lib/events';
import { listSessionSchedules } from '@main/core/automations/repo';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import {
  schedulesBySession,
  sessionScheduleDigest,
  type SessionSchedule,
} from '@shared/core/automations/session-schedule';
import { log } from '@main/lib/logger';
import {
  legacyAgentStatusWord,
  parseAgentStatus,
  parseAgentStatusDetail,
} from '@gugu/core/shared/agentStatus';
import {
  sessionChangedChannel,
  sessionCreatedChannel,
  type AgentStatusChange,
} from '@shared/core/sessions/sessionEvents';
import { locateSessionRecord } from './locate';
import { OpenedFileError, readOpenedFileChunk } from './opened-file';
import { sessionOpenedFile, sessionOutputs } from '../sessions/session-outputs';
import { readStartFailure } from './start-failures';
import { sessionLife } from '@main/core/sessions/session-life';
import { runtimeFork } from '@main/core/sessions/session-life-forks';
import { notStartedSessionOptions } from './not-started-options';
import { readSessionModelMenu, readSessionPermissionAgentName, type SessionpageSessionOptionsWithMenu } from './session-model-menu';
import {
  acpSessionLive,
  deliverPermissionDecision,
  deliverQuestionAnswer,
  deliverSessionCancel,
  deliverSessionText,
  ensureAcpSessionLive,
  permissionChannelError,
  prepareQuestionAnswer,
  SessionWriteError,
  type PreparedQuestionAnswer,
  type SessionWriteTarget,
} from './write-bridge';
import { syncPending } from './live-feed';
import { timelineFactory } from './record-timeline';
import { indexSource, locateRow, readLocalProjects, readSessionRow, readSessionRows, summaryRuntime } from './session-rows';
import { unsubscribeAll } from './subscriptions';
import { acquire, beginEntriesReset, disposeAllEntries, entries, fail, release, resetGeneration, withTimeline, type SessionTimelineResult } from './timeline-entries';

/**
 * 宿主侧会话时间线服务:会话列表与摘要、选项、历史分页、文件与后台任务、整机列表订阅、写侧。
 * 缓存与引用计数在 `timeline-entries.ts`,记录源在 `record-timeline.ts`,实时流在 `live-feed.ts`,
 * 会话行在 `session-rows.ts`,正文订阅在 `subscriptions.ts`;从这里搬走的导出照旧从这里导出。
 */

export { setSessionTimelineFactory } from './record-timeline';
export type { SessionTimelineFactory } from './record-timeline';
export { locateRow, readSessionRow, setConnectionConfigRootResolver } from './session-rows';
export type { ConnectionConfigRootResolver } from './session-rows';
export { subscribe, subscribePreview, unsubscribe, unsubscribeAll } from './subscriptions';
export type { SessionTimelineFailure, SessionTimelineResult } from './timeline-entries';










/** Publish the already-owned host requests alongside the runtime queue. */
export function syncAsked(conversationId: string): void {
  const entry = entries.get(conversationId);
  if (entry) syncPending(entry);
}







/**
 * 会话行上的读数过网:新字段 `status` 带基础态 + 附属态,老字段 `agentStatus` 写老版本手机认得的词
 * (spec agent-status-vocabulary)。与 `mapSessionRowToSession` 读的是同一对列、同一个解析。
 */
function statusFieldsOf(row: SessionRow): Pick<SessionpageSessionSummary, 'agentStatus' | 'status'> {
  const status = parseAgentStatus(row.agentStatus);
  return {
    agentStatus: legacyAgentStatusWord(status),
    status: status === null ? null : { status, detail: parseAgentStatusDetail(row.agentStatusDetail, status) },
  };
}

// ─── 对外动作 ──────────────────────────────────────────────────────────────

/**
 * 没有记录可读的会话,摘要里多带两格:是哪一种(还没开起来 / 这一家没接),以及上次起它失败的原因码。
 * 各端据此在转录末尾说清楚、给「再试一次」—— ❌ 把 `unsupportedReason` 那句开发者原文摊给人看。
 */
function notStartedFacts(row: SessionRow): Pick<SessionpageSessionSummary, 'recordState' | 'startFailure'> {
  if (!locateSessionRecord({ provider: row.provider, providerSessionId: 'probe' }).supported) {
    return { recordState: 'harness-unsupported' };
  }
  let failure: string | null = null;
  try {
    failure = readStartFailure(row.id);
  } catch (error) {
    log.warn('sessionTimeline: 读起会话失败原因失败(不影响列表)', { conversationId: row.id, error: String(error) });
  }
  return { recordState: 'not-started', ...(failure ? { startFailure: failure } : {}) };
}

/** 这台机器的会话列表:手机、别的电脑、App 读的都是这一份(会话页路由表 `sessionTimeline.sessionsList`)。 */
export async function listSessions(): Promise<SessionpageSessionsListResult> {
  return sessionList(await sessionAgents(process.env));
}

/** Resolve the canonical binding even when its task is archived; a missing task is an orphan, not an offline host. */
export async function sessionOfAgent(agentUserId: string): Promise<{ projectId: string; sessionId: string } | null> {
  const wanted = agentUserId.replace(/^user:/, '');
  if (!wanted) throw new Error('Agent identity is required');
  const bound = [...await agentIdsBySession(process.env)].filter(([, id]) => id === `user:${wanted}`);
  if (bound.length > 1) throw new Error('Agent identity is bound to multiple tasks');
  if (!bound.length) return null;
  const [row] = db.select({ projectId: sessions.projectId, sessionId: sessions.id }).from(sessions).where(eq(sessions.id, bound[0][0])).limit(1).all();
  return row ?? null;
}

/**
 * 同一份列表(最近动过的在前),同步、不读名录(行上不带 agent):心跳的离线摘要只要前 `limit` 条,在库里截(#3340)。
 * `schedules: false`:行上不带定时标记 —— 心跳的摘要不报它,❌ 每一拍替它读一遍这批会话的定时与最近一次运行。
 */
export function listSessionStates(limit?: number, { schedules = true }: { schedules?: boolean } = {}): SessionpageSessionsListResult {
  return sessionList(null, limit, schedules);
}

/** 可能在忙的会话(状态既不是空闲也不是出错):换版忙不忙只看这几行,每一拍不随闲着的会话数长(#3340)。 */
export function activeSessionStates(): Array<Pick<SessionpageSessionSummary, 'conversationId' | 'runtime' | 'status'>> {
  return db.select().from(sessions).where(and(isNull(sessions.archivedAt), notInArray(sessions.agentStatus, ['idle', 'error']))).all()
    .map((row) => ({ conversationId: row.id, runtime: summaryRuntime(row.runtime), status: statusFieldsOf(row).status }));
}

function sessionList(agents: ReadonlyMap<string, { agentId: string; chatId: string | null }> | null, limit?: number, withSchedules = true): SessionpageSessionsListResult {
  const visibleProjects = readLocalProjects();
  const rows = readSessionRows(false, inArray(sessions.projectId, visibleProjects.map(project => project.id)), limit);
  const projectById = new Map<string, SessionpageProjectSummary>();
  const summaries: SessionpageSessionSummary[] = [];
  const ids = limit === undefined ? undefined : rows.map(({ session }) => session.id);
  const schedules = withSchedules ? schedulesBySession(listSessionSchedules(ids)) : new Map<string, SessionSchedule[]>();
  const answered = readAnsweredAsks(ids);

  for (const { session, project } of rows) {
    projectById.set(project.id, project);
    summaries.push(summaryOf(session, agents, schedules, answered));
  }
  // 还没开过会话的项目也要列:手机新建会话只能挑这里列出的项目,刚在电脑上打开的项目 ❌ 因为没会话就看不见
  // (#6985:在手机上给一台刚加的机器开第一条会话)。只列本机项目,与侧栏同一个口径:隐式的任务工作区不算
  // 一个项目(侧栏也不列它),它只在里面有会话时随会话出现。
  for (const project of visibleProjects) {
    if (isImplicitSessionHomeProjectId(project.id)) continue;
    if (!projectById.has(project.id)) projectById.set(project.id, project);
  }

  return { projects: [...projectById.values()], sessions: summaries };
}

/** 一条会话的摘要,与 `listSessions` 同一个投影;建会话时交回发起方,它就不用自己拼一份「不知道」的。 */
export async function sessionSummary(conversationId: string): Promise<SessionpageSessionSummary | null> {
  const [row] = db.select().from(sessions).where(eq(sessions.id, conversationId)).limit(1).all();
  return row ? summaryOf(row, await sessionAgents(process.env), schedulesBySession(listSessionSchedules([row.id])), readAnsweredAsks([row.id])) : null;
}

/**
 * `agents`:本机名录里「会话 → agent」(`user:<uuid>`)与主人和它的私聊,一次读完;null = 这一份不报 agent。
 * `schedules`:整台机器给自己排的定时按会话分好(一次读完),行上那枚定时标记从这里来。
 */
function summaryOf(
  session: SessionRow,
  agents: ReadonlyMap<string, { agentId: string; chatId: string | null }> | null,
  schedules: ReadonlyMap<string, SessionSchedule[]>,
  answered: ReadonlyMap<string, AnsweredAsk>
): SessionpageSessionSummary {
  const agent = agents?.get(session.id);
  const location = locateRow(session);
  const cwd = session.workspaceId ? persistedWorkspacePath(session.workspaceId) : null;
  return {
    ...(cwd ? { cwd } : {}),
    conversationId: session.id,
    projectId: session.projectId,
    title: taskName(session),
    // `harness` 报的是 provider 自己的 id：三家之外也要看得见是哪一家，
    // 而不是被折叠成一个「不支持」。
    harness: session.provider ?? 'unknown',
    runtime: summaryRuntime(session.runtime),
    ...statusFieldsOf(session),
    lastInteractedAt: session.lastInteractedAt,
    supported: location.supported,
    nativeInputVersion: 2,
    ...(session.runtime === 'acp' ? { nativeInputIdentity: true as const, nativeInputSteering: true as const } : {}),
    nativeLastMessage: nativeConversationListActivity(session.id),
    nativeUnreadKeys: nativeConversationUnread(session.id),
    nativeOwnerNotificationUnreadCount: nativeOwnerNotificationUnread(session.id).length,
    nativeUnreadAliases: nativeConversationAliases(session.id),
    ...(location.supported ? {} : { unsupportedReason: location.reason, ...notStartedFacts(session) }),
    // 这三项库里早就有,先前没往手机端传 —— 手机上于是既没有置顶区、也认不出未读、
    // 更画不出子 agent 的谱系,而桌面侧栏三样都有。口径与 `sessions/utils.ts`
    // 逐字相同,❌ 不在这里另立一套(两套必然漂移)。
    isPinned: session.isPinned === 1,
    isPinnedToSidebar: session.isPinnedToSidebar === 1,
    unseen: session.agentStatusSeen !== 1,
    parentConversationId: sessionParentId(session),
    spawnedByConversationId: sessionSpawnerId(session),
    ...(session.config?.activitySourceLinks ? { activitySourceLinks: session.config.activitySourceLinks } : {}),
    ...(agents ? { agent: agent ? { userId: agent.agentId.slice('user:'.length) } : null } : {}),
    // 这条会话的对话:主人和它的 agent 的私聊 —— 别的机器、手机都从这一行拿到它(任务页里 App 的 `ctx.chat`)。
    ...(agent?.chatId ? { chatId: agent.chatId } : {}),
    spawnedByExtensionId: session.spawnedByExtensionId ?? null,
    bornInChatId: sessionBornInChatId(session.config),
    schedule: sessionScheduleDigest(schedules.get(session.id) ?? []),
    lastAnswered: answered.get(session.id) ?? null,
  };
}

export function snapshot(input: {
  conversationId: string;
  limit?: number;
}): Promise<SessionTimelineResult<TimelineSnapshot>> {
  return withTimeline(input.conversationId, (timeline) =>
    timeline.getSnapshot(input.limit === undefined ? undefined : { limit: input.limit })
  );
}

export function after(input: {
  conversationId: string;
  cursor: RecordCursor;
  terminalPatch?: boolean;
}): Promise<SessionTimelineResult<TimelineAfterResult>> {
  return withTimeline(input.conversationId, async (timeline, floor) => {
    // Asked for now (a revert just landed, say): the record as written by now, wherever it now is.
    await timeline.catchUp();
    if (floor && !input.cursor.epoch.endsWith(historyClearEpoch(floor))) return { ok: false as const, reset: 'epoch_changed' as const, snapshot: timeline.getSnapshot() };
    const options = { terminalPatch: input.terminalPatch === true };
    return timeline.getAfter(floor ? { ...input.cursor, epoch: input.cursor.epoch.slice(0, -historyClearEpoch(floor).length) } : input.cursor, options);
  });
}

/**
 * 这条聊天腿会话**从没开起来过**:没有 provider 会话 id,运行时里也没有它(正在起的那一刻不算 —— 那时
 * 运行时里有一份 `starting`)。建会话时 agent 没起来的就是这种,不论当时有没有记下原因码
 * (装这版之前建的那些没有)。对它 ❌ 走「唤醒」:唤醒不带第一句话。运行时问不到 = 抛(调用方报错),❌ 猜。
 */
async function neverStarted(row: SessionRow): Promise<boolean> {
  if (row.providerSessionId?.trim() || row.runtime !== 'acp') return false;
  return !(await acpSessionLive(row.id));
}

/** 那台机器上这家的模型目录里的显示名。目录读不到 = 抛,❌ 当空(胶囊上冒出引擎自己的模型 id)。 */
async function modelNames(provider: string | null): Promise<Map<string, string>> {
  if (!provider) return new Map();
  const { listLocalModels } = await import('@main/core/agents/session-discovery');
  const catalog = await listLocalModels(provider, { transport: 'acp' });
  return new Map(catalog.models.map((m) => [m.id, m.name]));
}

/** 会话记录里那一档模型(建会话 / 上次换模型时记下的),没有运行时也报得出来。 */
async function recordedSessionOptions(row: SessionRow) {
  const { sessionPlatformModel } = await import('@main/core/sessions/platform-model-selection');
  const platform = await sessionPlatformModel(row.id);
  return notStartedSessionOptions({
    model: runtimeModelId(row.config?.model),
    platformModelId: platform?.modelId,
    names: await modelNames(row.provider),
  });
}

/** 读这条会话此刻可改的选项。哪一步读不到都报 `options_failed`,❌ 给一份「没在跑」的选项充数。 */
export async function sessionOptions(input: SessionpageSessionOptionsRequest): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  try {
    if (await neverStarted(row)) return { ok: true, value: await withModelMenu(row, await recordedSessionOptions(row), input.includeOwnModelCatalog) };
    // #980 打开会话不叫醒 agent,手机上也一样(behavior session-page;owner 2026-10-30 取代 09-15「读选项先唤醒」):
    // 手机打开会话就来读这一份,而参数(权限档 / 推理档)住在活运行时里。没在跑就报记录里那一档模型(带模型菜单,换得了),
    // 权限档 / 推理档等它跑起来再报 —— 它们的 id 是各家运行时自己的。改一档是人点的,那一刻再起(`setSessionOptionValue`)。
    // 只读,❌ 为了问一句把它拉起来。
    if (row.runtime === 'acp' && !(await acpSessionLive(row.id))) {
      return { ok: true, value: await withModelMenu(row, await recordedSessionOptions(row), input.includeOwnModelCatalog) };
    }
    return { ok: true, value: await withModelMenu(row, await readSessionOptions(input.conversationId), input.includeOwnModelCatalog) };
  } catch (error) {
    return optionsFailure(error);
  }
}

/** 改一项。返回**回读**到的那份，❌ 不把入参当结果。 */
export async function setSessionOptionValue(
  input: SessionpageSessionSetOptionRequest
): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  // #980 打开时没叫醒它;改一档是人点的,参数又只有活运行时收得下 ⇒ 这一刻按桌面同一条「唤醒」拉起来。
  // 从没开起来的 ❌:唤醒不带第一句话(见 not-started-options),它只报记下的那一档,本来就没有可改的。
  try {
    if (row.runtime === 'acp' && !(await neverStarted(row))) await ensureAcpSessionLive(row.id);
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    return fail('session_wake_failed', (error as Error)?.message ?? String(error));
  }
  try {
    return { ok: true, value: await withModelMenu(row, await setSessionOption(input)) };
  } catch (error) {
    return optionsFailure(error);
  }
}

/**
 * 换到另一条计费路上的模型 —— 桌面会话菜单确认「打断并切换」之后走的同一个宿主入口(`reloadEmdashSession`):
 * 先把模型与计费路写进会话记录,再停、再起、续上历史。回的是重开之后回读到的那份选项。
 */
export async function reloadSessionModel(
  input: SessionpageSessionReloadModelRequest
): Promise<SessionTimelineResult<SessionpageSessionOptionsWithMenu>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  try {
    const { reloadEmdashSession } = await import('@main/embedded-boot');
    await reloadEmdashSession({
      sessionId: row.id,
      reason: 'model-switch',
      model: input.model,
      modelSource: input.modelSource,
    });
  } catch (error) {
    return fail('reload_failed', (error as Error)?.message ?? String(error));
  }
  return sessionOptions({ conversationId: row.id });
}

/**
 * 附上手机排菜单要的事实(见 session-model-menu):模型那一档在场时是模型菜单,权限那一档在场时是这家声明的
 * 档位表(#6693:手机从前自带一张只认 Claude 的表,hermes 的 `default` 实为「编辑」却被写成「照常问我」)。
 */
async function withModelMenu(
  row: SessionRow,
  options: SessionpageSessionOptions,
  includeOwnModelCatalog?: true
): Promise<SessionpageSessionOptionsWithMenu> {
  if (!row.provider) return options;
  const declared = declaredModeMap(row.provider);
  if (declared?.['ai-review']) {
    const platform = await (await import('@main/core/sessions/platform-model-selection')).sessionPlatformModel(row.id);
    const read = platform === undefined ? null : await (await import('./create-session')).createModels({ harness: row.provider, sessionView: 'general',
      model: platform ? 'platform:' + platform.modelId : row.config?.model });
    const group = (read?.ok ? read.value.permissionOptions : null) ?? buildSessionPermissionOptions({ modeMap: declared });
    options = { ...options, mode: group ? { ...group, selected: options.mode?.selected ?? (row.config?.permissionMode ? declared[row.config.permissionMode]?.id ?? null : null) } : null };
  }
  const modeMap = options.mode ? declared : undefined;
  const modelMenu = options.model ? await readSessionModelMenu(row.id, row.provider, includeOwnModelCatalog) : undefined;
  const permissionAgentName = options.mode ? modelMenu?.agentName ?? await readSessionPermissionAgentName(row.provider) : undefined;
  return { ...options, ...(modelMenu ? { modelMenu } : {}), ...(modeMap ? { modeMap } : {}), ...(permissionAgentName ? { permissionAgentName } : {}) };
}

/** 这家声明的权限档表;没声明(或不认识这家)就没有。 */
function declaredModeMap(provider: string) {
  try {
    const autoApprove = getPlugin(provider).capabilities.autoApprove;
    return autoApprove?.kind === 'supported' ? autoApprove.modes : undefined;
  } catch {
    return undefined;
  }
}

function optionsFailure(error: unknown): SessionTimelineResult<never> {
  if (error instanceof SessionOptionsError) return fail(error.code, error.message);
  return fail('options_failed', (error as Error)?.message ?? String(error));
}

/** 往前翻更早的轮（懒加载）。 */
export function older(input: {
  conversationId: string;
  beforeTurnId?: string;
  limit?: number;
}): Promise<SessionTimelineResult<TimelineOlderResult>> {
  const beforeTurnId = input.beforeTurnId;
  if (!beforeTurnId) return Promise.resolve(fail('invalid_cursor', '历史分页游标无效'));
  return withTimeline(input.conversationId, (timeline) =>
    timeline.getOlder(
      input.limit === undefined
        ? { beforeTurnId }
        : { beforeTurnId, limit: input.limit }
    )
  );
}

/** One page of a session's conversation, oldest turn first. */
export type RecordHistoryPage = { turns: TimelineSnapshot['turns']; hasOlder: boolean };

/**
 * An App's `readAgentHistory` (#7126): one page of what a session said, as its own record has it — the record the
 * session page and the phone read, so an agent in a terminal, or one not open now, is read like an open panel. Its
 * newest `limit` turns, or the `limit` before the turn numbered `beforeSeq` (the cursor a page gave).
 * `no-record`: no record of its own here (its harness's is not one gugu decodes, or it never started) — the stand-in
 * says nothing the session said. `no-such-turn`: `beforeSeq` is no turn of it.
 */
export async function recordHistoryPage(input: {
  conversationId: string;
  limit: number;
  beforeSeq?: number;
}): Promise<SessionTimelineResult<RecordHistoryPage | 'no-record' | 'no-such-turn'>> {
  const acquired = await acquire(input.conversationId);
  if (!acquired.ok) return acquired;
  try {
    if (acquired.value.standIn) return { ok: true, value: 'no-record' };
    const timeline = acquired.value.timeline;
    const floor = await nativeConversationHistoryFloor(input.conversationId);
    // Read the moment a turn ended (radar's 「做完了」): the record as written by now, not as far as the tail got.
    await timeline.catchUp();
    if (input.beforeSeq === undefined) {
      const { turns, hasOlder } = timeline.getSnapshot({ limit: input.limit });
      return { ok: true, value: clearedHistoryResult({ turns, hasOlder }, floor) };
    }
    const at = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns.find((turn) => turn.seq === input.beforeSeq);
    if (!at) return { ok: true, value: 'no-such-turn' };
    const { turns, hasOlder } = timeline.getOlder({ beforeTurnId: at.id, limit: input.limit });
    return { ok: true, value: clearedHistoryResult({ turns, hasOlder }, floor) };
  } catch (error) {
    return fail('timeline_failed', (error as Error)?.message ?? String(error));
  } finally {
    release(acquired.value);
  }
}

/**
 * When the turn opened by the person's message `anchor` started: a revert to it removes that turn and every one after.
 * Null when the session's history has no such message (nothing of ours to cut).
 */
export async function revertPointStartedAt(conversationId: string, anchor: string): Promise<number | null> {
  const acquired = await acquire(conversationId);
  if (!acquired.ok) throw new Error(acquired.error.message);
  try {
    const timeline = acquired.value.timeline;
    await timeline.catchUp();
    const turn = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns
      .find((one) => one.items.some((item) => item.kind === 'message' && item.role === 'user' && item.revertAnchor === anchor));
    return turn?.startedAt ?? null;
  } finally {
    release(acquired.value);
  }
}

/**
 * Every turn of the session's record as written by now, the cleared part included (what the agent was sent stays
 * sent); 'no-record' when there is no record to read (a stand-in, a harness without a reader).
 */
export async function recordTurns(conversationId: string): Promise<TimelineSnapshot['turns'] | 'no-record'> {
  const acquired = await acquire(conversationId);
  if (!acquired.ok) throw new Error(acquired.error.message);
  try {
    if (acquired.value.standIn) return 'no-record';
    const timeline = acquired.value.timeline;
    await timeline.catchUp();
    return timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
  } finally {
    release(acquired.value);
  }
}

/** The session's history as the person sees it now: every turn of its timeline after the cleared part. */
export async function historyTurns(conversationId: string): Promise<TimelineSnapshot['turns']> {
  const acquired = await acquire(conversationId);
  if (!acquired.ok) throw new Error(acquired.error.message);
  try {
    const timeline = acquired.value.timeline;
    const floor = await nativeConversationHistoryFloor(conversationId);
    await timeline.catchUp();
    return clearedHistoryResult({ turns: timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns }, floor).turns;
  } finally {
    release(acquired.value);
  }
}


export async function backfillSessionIndex(conversationId: string, respectRetry = true) {
  const row = readSessionRow(conversationId);
  if (!row || entries.has(conversationId)) return 'unchanged';
  return indexSessionRecord(conversationId, indexSource(row, locateRow(row, true)), { backfill: true, respectRetry });
}

/** Runtime decisions use the authoritative open timeline before falling back to the derived facts. */
export async function sessionHasRecordedTurn(conversationId: string): Promise<boolean> {
  const entry = entries.get(conversationId);
  if (entry && !entry.standIn) return entry.timeline.getSnapshot({ limit: 1 }).turns.length > 0;
  await prepareSessionIndex();
  if (indexedTurnCount(conversationId) > 0) return true;
  const row = readSessionRow(conversationId, { includeArchived: true });
  if (!row) return false;
  const source = indexSource(row, locateRow(row));
  if (!source.locator && !source.journal) return false;
  await indexSessionRecord(conversationId, source);
  return indexedTurnCount(conversationId) > 0;
}

/** The settling watch owns this reader. It cannot populate or dispose the interactive cache. */
async function openIngestionRecord(conversationId: string, includeArchived?: boolean): Promise<SessionTimeline | null> {
  const row = readSessionRow(conversationId, { includeArchived });
  if (!row || !timelineFactory) return null;
  const location = locateRow(row);
  if (!location.supported) return null;
  const generation = resetGeneration;
  const timeline = await timelineFactory({ locator: location.locator, conversationId });
  if (generation !== resetGeneration) { timeline.dispose(); return null; }
  return timeline;
}


/**
 * A terminal reports idle before its buffered record write lands (record-backfill `settling`). Ingestion follows
 * the same live record reader until the last turn carries its outcome: `true` = it settled, `false` = `signal` ended
 * the watch first. A record that cannot be reopened fails loudly.
 */
export async function watchRecordSettled(conversationId: string, signal: AbortSignal): Promise<boolean> {
  const timeline = await openIngestionRecord(conversationId, true);
  if (!timeline) throw new Error(`record unavailable for ${conversationId}`);
  let unsubscribe = () => {};
  try {
    return await new Promise<boolean>((resolve) => {
      const check = () => { if (timeline.getSnapshot({ limit: 1 }).turns.at(-1)?.outcome) resolve(true); };
      signal.addEventListener('abort', () => resolve(false), { once: true });
      if (signal.aborted) resolve(false);
      unsubscribe = timeline.subscribe(timeline.getSnapshot({ limit: 1 }).cursor, check);
      // The reader caught up while opening: an outcome that landed after the settling snapshot is already here.
      check();
    });
  } finally {
    unsubscribe();
    timeline.dispose();
  }
}


/**
 * 手机点开一张附件卡(#7193):读这条会话打开给人看的那份文件的一段(`opened-file.ts`)。只读它真的打开过的 ——
 * 依据是宿主记下的那一份(`session-outputs.ts`),与桌面「输出」同一个源,不分 harness。
 */
export async function readOpenedFile(
  input: SessionpageOpenedFileReadRequest
): Promise<SessionTimelineResult<SessionpageOpenedFileChunk>> {
  try {
    if (!(await sessionOpenedFile(input.conversationId, input.path)) && !(await ownerNotificationFile(input.conversationId, input.path))) {
      return fail('not_opened', `这条会话没有打开过 ${input.path}`);
    }
    return { ok: true, value: await readOpenedFileChunk(input.path, input.offset, input.length) };
  } catch (error) {
    if (error instanceof OpenedFileError) return fail(error.code, error.message);
    return fail('read_failed', (error as Error)?.message ?? String(error));
  }
}

/** 这条会话给人打开过的文件与网页,最近的在前(桌面「输出」、手机读的都是这一份)。 */
export async function outputs(input: { conversationId: string }): Promise<SessionTimelineResult<OpenedOutput[]>> {
  return { ok: true, value: await sessionOutputs(input.conversationId) };
}

/**
 * 这条会话的运行时说「本进程里还在跑」的后台命令(#6582 那道筛子,手机看会话末尾那一句用;桌面读的是自己 store 里同一格)。
 * 会话不在运行时里 ⇒ `[]`(没有活着的进程,就没有在跑的命令);运行时没报这一格(旧运行时)⇒ `null` = 不筛。
 */
export async function backgroundTasks(input: {
  conversationId: string;
}): Promise<SessionTimelineResult<{ runningCommandTaskIds: string[] | null }>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    // 用时再 import:它们拖着运行时进程那一串(app scope),只读时间线的路不该替它交税。
    const { readAcpSessionState } = await import('@main/core/acp/session-summary-reader');
    const state = await readAcpSessionState(row.id);
    return { ok: true, value: { runningCommandTaskIds: state ? (state.backgroundCommandTaskIds ? [...state.backgroundCommandTaskIds] : null) : [] } };
  } catch (error) {
    return fail('read_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 停一个后台任务:命令报供应商的 asyncTaskId,子智能体报派它的 tool_use id —— 与桌面那一行的停止键同一个调用
 * (`stopBackgroundTask`)。受理即返回,停没停下来看时间线。
 */
export async function stopBackgroundTask(input: {
  conversationId: string;
  stopId: string;
}): Promise<SessionTimelineResult<{ stopped: true }>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    const { getAcpRuntimeClient } = await import('@main/core/acp/runtime-process/host');
    const client = await getAcpRuntimeClient();
    const result = await client.stopBackgroundTask({ sessionId: row.id, taskId: input.stopId });
    if (!result.success) return fail('stop_failed', String((result.error as { message?: string })?.message ?? result.error));
    return { ok: true, value: { stopped: true } };
  } catch (error) {
    return fail('stop_failed', (error as Error)?.message ?? String(error));
  }
}


// ─── 整台机器的会话列表订阅 ──────────────────────────────────────────────────

/**
 * 「哪条会话此刻卡在人这儿」的事实源:状态写入者写下之后的那份输出(spec agent-status-writer)。
 *
 * 由宿主在开机时注入 `onAgentStatus` —— ❌ 这里不 import embedded-boot：那个模块 import 的正是本模块
 * （经 device-rpc），直接引会成环。也 ❌ 不自造第二份「事件 → 状态」的推导：仓里已经因为同形拷贝各改各的
 * 踩过一次（#3961，presence 读的一直是没改的那份）。已读也经写入者播出,所以手机列表的未读跟着变。
 */
type SessionStatusFeed = (cb: (change: AgentStatusChange) => void) => () => void;

let sessionStatusFeed: SessionStatusFeed | null = null;

export function setSessionStatusFeed(feed: SessionStatusFeed | null): void {
  sessionStatusFeed = feed;
}

const sessionsSubscriptions = new Map<string, { stop: () => void }>();

/** 状态可能连着跳好几下（working → needs_user）；合并到一帧再推，❌ 一次变化推一份列表。 */
const SESSIONS_PUSH_DEBOUNCE_MS = 200;

/** 列表上看得见、又不经状态写入者的变化:会话增删、这几格元信息,以及会话给自己排的定时。 */
const LISTED_FIELDS = ['title', 'isPinned', 'isPinnedToSidebar', 'archivedAt', 'parentSessionId', 'nativeUnreadKeys', 'nativeLastMessage', 'lastAnswered'];
function changesSessionList(channel: string, data: unknown): boolean {
  if (channel === sessionCreatedChannel.name) {
    return true;
  }
  // 行上那枚定时标记:排上、取消、到点、没送到都经这两条(automations-service)。
  if (channel === automationChangedChannel.name || channel === automationRunChangedChannel.name) return true;
  if (channel !== sessionChangedChannel.name) return false;
  const changes = (data as { changes?: Record<string, unknown> } | null)?.changes ?? {};
  return LISTED_FIELDS.some((field) => field in changes);
}

/**
 * 整台机器的会话列表订阅。订上那一刻的整份是订阅的一部分:先算出它,算不出来就把错误照常交回(客户端的退避接住),
 * ❌ 回一个「订上了」再永远不推。算出来了就拿它当底推出去,之后只推变了的行(sessionListDelta)。
 */
export async function subscribeSessions(
  subscriptionId: string,
  emit: (event: SessionpageSessionsEvent) => void
): Promise<SessionTimelineResult<{ subscriptionId: string }>> {
  unsubscribeSessions(subscriptionId);
  if (!sessionStatusFeed) {
    // fail loud：没有事实源就说没有，❌ 不返回一个永远不推的订阅冒充成功 ——
    // 那样手机会一直等一个不会来的提醒，而屏幕上看不出任何异常。
    return fail('status_feed_missing', '宿主没有接入会话状态事实源');
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 底还没算出来时来的变化:先记下,底推出去之后补一次。 */
  let ready = false;
  let dirty = false;
  /** 这条订阅上一次推出去的那份:增量就是拿它与这一份比出来的。 */
  let last: SessionpageSessionsListResult | null = null;
  /** 一次只算一份,按顺序推:两份交错推出去,后算的先到,客户端就合乱了。 */
  let pushing: Promise<void> = Promise.resolve();
  const push = (): void => {
    timer = null;
    pushing = pushing.then(async () => {
      if (stopped || !last) return;
      let next: SessionpageSessionsListResult;
      try {
        next = await listSessions();
      } catch (error) {
        // 列不出来(名录读坏了)响亮记下,这一份不推;下一次变化再列。❌ 推一份缺行的冒充整份。
        log.error('sessionTimeline: 会话列表推送列不出来', { subscriptionId, error: String(error) });
        return;
      }
      if (stopped) return;
      const delta = sessionListDelta(last, next);
      last = next;
      if (delta) emit({ subscriptionId, ...delta });
    });
  };
  const schedule = (): void => {
    if (!ready) {
      dirty = true;
      return;
    }
    if (stopped || timer) return;
    timer = setTimeout(push, SESSIONS_PUSH_DEBOUNCE_MS);
    timer.unref?.();
  };
  // 先挂上变化来源再算底:算的那一会儿里的变化不会漏(记成 dirty,底推出去后补一次)。
  const stops = [
    sessionStatusFeed(schedule),
    tapMainEvents((channel, data) => {
      if (changesSessionList(channel, data)) schedule();
    }),
  ];
  const mine = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const off of stops) off();
    },
  };
  // 先登记再算底:算的那一会儿里线断了 / 退订了,拆的就是这一条,回来时不再推(❌ 给死掉的线留一条孤儿)。
  sessionsSubscriptions.set(subscriptionId, mine);

  try {
    last = await listSessions();
  } catch (error) {
    mine.stop();
    if (sessionsSubscriptions.get(subscriptionId) === mine) sessionsSubscriptions.delete(subscriptionId);
    return fail('sessions_list_failed', `会话列表列不出来: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stopped) return fail('unsubscribed', '订阅在建好之前就被退掉了');
  emit({ subscriptionId, full: last });
  ready = true;
  if (dirty) schedule();
  return { ok: true, value: { subscriptionId } };
}

export function unsubscribeSessions(subscriptionId: string): void {
  const active = sessionsSubscriptions.get(subscriptionId);
  if (!active) return;
  sessionsSubscriptions.delete(subscriptionId);
  active.stop();
}

export function unsubscribeAllSessions(): void {
  for (const id of [...sessionsSubscriptions.keys()]) unsubscribeSessions(id);
}


function writeTargetFrom(row: SessionRow): SessionWriteTarget {
  return mapSessionRowToSession(row);
}

type InputAdmissionResult = SessionTimelineResult<{ accepted: 'started' | 'queued'; clientMessageId?: string; admission: 'accepted' }>;
const admittingInputs = new Map<string, { input: InputAdmissionPayload; result: Promise<InputAdmissionResult> }>();

export async function send(input: InputAdmissionPayload, admissionFence?: () => void): Promise<InputAdmissionResult> {
  admissionFence?.();
  const { conversationId, clientMessageId } = input;
  if (!clientMessageId) return sendOnce(input, admissionFence);
  const key = JSON.stringify([conversationId, clientMessageId]);
  const pending = admittingInputs.get(key);
  if (pending) return sameInput(input, pending.input) ? pending.result : {
    ok: false, error: { code: 'invalid_request', message: '原消息尚在确认，不能更换内容', admission: 'uncertain' },
  };
  const result = sendOnce(input, admissionFence);
  admittingInputs.set(key, { input, result });
  try { return await result; }
  finally { admittingInputs.delete(key); }
}

async function sendOnce(input: InputAdmissionPayload, admissionFence?: () => void): Promise<InputAdmissionResult> {
  const { conversationId, text, clientMessageId, files, attachments, annotations, steerIfBusy } = input;
  const rejected = (code: string, message: string): InputAdmissionResult => {
    try {
      const prior = priorInputAdmission(input);
      return prior === 'accepted'
        ? { ok: true, value: { accepted: 'queued', admission: 'accepted', clientMessageId } }
        : { ok: false, error: { code, message, admission: prior ?? 'rejected' } };
    } catch (error) {
      return { ok: false, error: { code: 'send_failed', message: (error as Error)?.message ?? String(error), admission: 'uncertain' } };
    }
  };
  if (steerIfBusy !== undefined && steerIfBusy !== true) return rejected('invalid_request', '插话意图无效');
  if (files !== undefined && !turnFileRefSchema.array().safeParse(files).success) return rejected('invalid_request', '附件引用无效');
  if (attachments !== undefined && !promptAttachmentSchema.array().safeParse(attachments).success) return rejected('invalid_request', '附件引用无效');
  if (annotations !== undefined && !turnAnnotationSchema.array().safeParse(annotations).success) return rejected('invalid_request', '评论无效');
  if (clientMessageId !== undefined && (!clientMessageId.trim() || clientMessageId.length > 256)) return rejected('invalid_request', '消息标识无效');
  if (!text.trim() && !files?.length && !attachments?.length && !annotations?.length) return rejected('empty_text', '消息是空的');
  // Confirm custody before re-reading a provider or resolving files whose permissions may have changed.
  try {
    const prior = priorInputAdmission(input);
    if (prior === 'accepted') return { ok: true, value: { accepted: 'queued', admission: 'accepted', clientMessageId } };
    if (prior === 'uncertain') return { ok: false, error: { code: 'input_conflict', message: '原消息的接管记录尚无法确认', admission: 'uncertain' } };
  } catch (error) {
    return { ok: false, error: { code: 'send_failed', message: (error as Error)?.message ?? String(error), admission: 'uncertain' } };
  }
  // A side chat has no session row: its custody send lands in its fork entry's queue.
  if (runtimeFork(conversationId)) {
    try {
      admissionFence?.();
      sessionLife().enqueue({ sessionId: conversationId, messageId: clientMessageId ?? crypto.randomUUID(), text: text.trim(), kind: 'ordinary',
        delivery: { queue: true, origin: 'manual', ...(steerIfBusy ? { steerIfBusy } : {}), ...(files?.length ? { files } : {}), ...(attachments?.length ? { attachments } : {}),
          ...(annotations?.length ? { annotations } : {}) } });
      return { ok: true, value: { accepted: 'queued', admission: 'accepted', ...(clientMessageId ? { clientMessageId } : {}) } };
    } catch (error) {
      return { ok: false, error: { code: error instanceof SessionInputAdmissionError ? error.code ?? 'send_failed' : 'send_failed',
        message: (error as Error)?.message ?? String(error), admission: sessionInputAdmission(error) } };
    }
  }
  const row = readSessionRow(conversationId);
  if (!row) return rejected('session_not_found', '这台机器上已没有这条任务');
  // provider 为空 = 这一行没记下是哪家引擎；再往下走只会在插件表里抛一句认不出来的话。
  if (!row.provider?.trim()) {
    return rejected('provider_unknown', '任务没有记下 provider，投不出去');
  }
  // 还没开起来的会话(建的时候 agent 没起来,#6264):先按「再试一次」同一条路把它起来 —— 第一句话随之投递 ——
  // 再发这一句。❌ 直接唤醒:唤醒不带第一句,agent 会只看到后来这一句。
  // A never-started session is ACP only (neverStarted), and its delivery itself starts it (session-life row 1).
  try {
    const accepted = await deliverSessionText(writeTargetFrom(row), input, admissionFence);
    return { ok: true, value: { ...accepted, admission: 'accepted', ...(clientMessageId ? { clientMessageId } : {}) } };
  } catch (error) {
    if (sessionInputAdmission(error) === 'rejected') return rejected(error instanceof SessionWriteError || error instanceof SessionInputAdmissionError ? error.code ?? 'send_failed' : 'send_failed', (error as Error)?.message ?? String(error));
    return { ok: false, error: { code: error instanceof SessionWriteError || error instanceof SessionInputAdmissionError ? error.code ?? 'send_failed' : 'send_failed',
      message: (error as Error)?.message ?? String(error), admission: sessionInputAdmission(error) } };
  }
}

/** 停掉这条会话正在飞的一轮。受理即返回;停没停下来由时间线自己结算(与发送同一口径)。 */
export async function cancel(
  conversationId: string
): Promise<SessionTimelineResult<SessionpageSessionCancelResult>> {
  const row = readSessionRow(conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${conversationId}`);
  withdrawAll(conversationId, 'agent-question');
  try {
    return { ok: true, value: await deliverSessionCancel(writeTargetFrom(row)) };
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    return fail('cancel_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 重命名 / 置顶 / 归档 —— 桌面侧栏右键菜单同三条操作,❌ 不另写。顺序:先改名、再置顶、最后归档
 * (归档会把行从列表收起,放最后)。归档先停运行时,停不下来就抛 —— 原话回给手机。
 */
export async function updateSession(
  input: SessionpageSessionUpdateRequest
): Promise<SessionTimelineResult<SessionpageSessionUpdateResult>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${input.conversationId}`);
  try {
    if (typeof input.title === 'string') {
      if (!input.title.trim()) return fail('title_empty', '名字不能是空的');
      const { renameSession } = await import('@main/core/sessions/renameSession');
      await renameSession(row.id, input.title);
    }
    if (typeof input.pinned === 'boolean') {
      const { setSessionPinned } = await import('@main/core/sessions/setSessionPinned');
      await setSessionPinned(row.id, input.pinned);
    }
    if (input.archived === true) {
      const { archiveSession } = await import('@main/core/sessions/archiveSession');
      await archiveSession(row.projectId, row.id, { removeSocialIdentity: input.removeSocialIdentity });
    }
    const after = db.select().from(sessions).where(eq(sessions.id, row.id)).get();
    return {
      ok: true,
      value: {
        title: taskName(after ?? row),
        isPinned: (after?.isPinned ?? row.isPinned) === 1,
        archived: !!after?.archivedAt,
      },
    };
  } catch (error) {
    return fail('update_failed', (error as Error)?.message ?? String(error));
  }
}

/**
 * 回答一个审批/提问项。
 *
 * **先 CAS 再投递**：谁先在时间线上把这一项从 pending 抢成 resolved，谁才有资格去动 provider。
 * 反过来（先投递再记账）两个端会各投一次，而 provider 侧只认第一次 —— 第二个人得到的
 * 「成功」是假的。
 *
 * 投递失败要把这一项放回 pending（`releaseSettlement`），让人重答。
 * ❌ 别用 `cancelSettlement` 顶替：那是「provider 侧已了结」，会把一条还能救的显示成已取消。
 *
 * 抢跑失败**不是错误**：它走正常应答、带回那条既有结算（`accepted: false`），
 * 端上据此显示「已在某端回答」。做成错误码的话，端上要显示这句话就得从一个
 * 只有 message 的失败里去猜是谁答的 —— 也正是先前那条错位字符串的来处。
 */
export async function respond(
  input: SessionpageSessionRespondRequest
): Promise<SessionTimelineResult<SessionpageSessionRespondResult>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', '这台机器上没有这条会话');
  const result = await respondOn(row, input);
  // Every surface answers through here, so the list learns of an answer once, whichever device gave it.
  if (result.ok && result.value.accepted) {
    recordAnsweredAsk(row.id, answeredAskOf(result.value.settlement));
    events.emit(sessionChangedChannel, { sessionId: row.id, projectId: row.projectId, changes: { lastAnswered: true } });
  }
  return result;
}

async function respondOn(
  row: SessionRow,
  input: SessionpageSessionRespondRequest
): Promise<SessionTimelineResult<SessionpageSessionRespondResult>> {
  const target = writeTargetFrom(row);

  const acquired = await acquire(input.conversationId);
  if (!acquired.ok) return acquired;
  if (acquired.value.standIn) {
    release(acquired.value);
    return fail('session_not_started', '这条会话还没有开出来,没有可回答的请求');
  }
  const { timeline } = acquired.value;
  try {
    if (!('optionId' in input)) {
      const question = settlementOf(timeline, input.itemId);
      if (question?.origin?.source === 'agent-question') return respondAskQuestion(timeline, input, question);
      return await respondQuestion(target, timeline, input);
    }
    // D-31 The host's own ask: settled here, on either kind of session — no runtime to hand it to.
    const current = settlementOf(timeline, input.itemId);
    if (current?.origin?.source === 'agent-question') return fail('answer_invalid', '请提交这道题的完整回答');
    if (current?.origin) {
      const source = askSourceSpec(current.origin.source);
      if (!source) {
        timeline.cancelSettlement(current.itemId);
        const cancelled = settlementOf(timeline, current.itemId);
        if (!cancelled) throw new Error('Cancelled request is missing from the timeline');
        return { ok: true, value: { accepted: false, settlement: cancelled } };
      }
      if (source.raisedBy === 'host') return respondAsk(timeline, input, current);
    }
    // 这条腿上根本没有结算口 ⇒ 抢之前就拒,❌ 抢成 resolved 推出去再放回(#6739)。
    const unavailable = permissionChannelError(target, input.kind);
    if (unavailable) return fail(unavailable.code, unavailable.message);
    const settled = timeline.settle({
      itemId: input.itemId,
      optionId: input.optionId,
      by: input.by,
    });
    if (!settled.ok) {
      return { ok: true, value: { accepted: false, settlement: settled.existing } };
    }
    try {
      await deliverPermissionDecision(target, { itemId: input.itemId, optionId: input.optionId });
    } catch (error) {
      timeline.releaseSettlement(input.itemId);
      if (error instanceof SessionWriteError) return fail(error.code, error.message);
      return fail('respond_failed', (error as Error)?.message ?? String(error));
    }
    return { ok: true, value: { accepted: true, settlement: settled.settlement } };
  } finally {
    release(acquired.value);
  }
}

/**
 * 终端提问(#6798、#7035):核对回答 → 认领 → 写取消键关掉选择器 → 等记录里这道题有了结果 → 把回答当消息发过去。
 * 回答发出去就是受理;agent 接下来怎么做以记录为准,卡片跟着记录走。
 */
async function respondQuestion(
  target: SessionWriteTarget,
  timeline: SessionTimeline,
  input: Exclude<SessionpageSessionRespondRequest, { optionId: string }>
): Promise<SessionTimelineResult<SessionpageSessionRespondResult>> {
  await timeline.catchUp();
  const current = settlementOf(timeline, input.itemId);
  const unavailable = permissionChannelError(target, 'question', current?.questions);
  if (unavailable) return fail(unavailable.code, unavailable.message);
  if (!current?.questions) return fail('question_not_found', '这条会话里没有这道提问');
  if ('discuss' in input) return fail('answer_invalid', 'Discussion is only available for a host question');
  let prepared: PreparedQuestionAnswer;
  try {
    prepared = prepareQuestionAnswer(target, current.questions, 'decline' in input ? 'decline' : input.answers);
  } catch (error) {
    if (error instanceof SessionWriteError) return fail(error.code, error.message);
    throw error;
  }
  const settled = timeline.settle({ itemId: input.itemId, optionId: null, by: input.by });
  if (!settled.ok) return { ok: true, value: { accepted: false, settlement: settled.existing } };

  const stillOpen = async () => {
    await timeline.catchUp();
    return timeline.questionOpen(input.itemId);
  };
  const delivered = await deliverQuestionAnswer(target, prepared, { askedAt: current.askedAt, stillOpen });
  if (!delivered.ok) {
    if (delivered.error.code === 'question_gone') {
      // 问出这道题的进程已经不在了:这条永远等不到结果,作废它,❌ 放回可答。
      timeline.releaseSettlement(input.itemId);
      timeline.cancelSettlement(input.itemId);
      return fail(delivered.error.code, delivered.error.message);
    }
    // 其余失败一律放掉认领:选择器还开着 ⇒ 回到可答(再答 = 再按一次取消键,无害);
    // 已经有了结果(终端那头答了,或取消了却没发出回答)⇒ 放掉即「不需要回答了」,原因随错误带回。
    await timeline.catchUp();
    timeline.releaseSettlement(input.itemId);
    return fail(delivered.error.code, delivered.error.message);
  }
  return { ok: true, value: { accepted: true, settlement: settled.settlement } };
}

function settlementOf(timeline: SessionTimeline, itemId: string): Settlement | null {
  return timeline.getSnapshot({ limit: 1 }).settlements.find((s) => s.itemId === itemId) ?? null;
}

/** 测试与收尾用：拆掉所有订阅与缓存实例。 */
export function resetSessionTimelineService(): void {
  resetAsks();
  beginEntriesReset();
  unsubscribeAll();
  disposeAllEntries();
}

export async function changeQueue(input: { conversationId: string; action: import('@gugu/session-core/session-record/contract').SessionpageQueueAction }): Promise<SessionTimelineResult<null>> {
  const row = readSessionRow(input.conversationId);
  if (!row) return fail('session_not_found', 'The session is no longer available');
  if (row.runtime !== 'acp') return fail('unsupported_runtime', 'This session does not expose a prompt queue');
  try {
    const { changeConversationQueue } = await import('./conversation-queue');
    await changeConversationQueue(row.id, input.action);
    return { ok: true, value: null };
  } catch (error) {
    return fail('queue_update_failed', error instanceof Error ? error.message : String(error));
  }
}

export { nativeAttachment } from './native-attachment';
