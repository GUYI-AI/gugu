import { nativeConversationHistoryFloor } from '../sessions/native-publication-host';
import { clearedHistoryResult } from '@gugu/session-core/session-record/conversation-history-clear';
import { type SessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission';
import { followSessionIndex } from '../session-index/session-index';
import {
  type SessionTimeline,
  type PendingRequest,
} from '@gugu/session-core/session-record';
import { mapSessionRowToSession } from '@main/core/sessions/utils';
import { type SessionRow } from '@main/db/schema';
import { log } from '@main/lib/logger';
import {
  dropTimelineArchive,
} from './archive-store';
import { type SessionStateWatch } from './live-permissions';
import { ensureJournal, journalLocator } from '../sessions/session-journal';
import { createStandInTimeline } from './stand-in-timeline';
import { sessionLife } from '@main/core/sessions/session-life';
import { creationMessageId } from '@main/core/sessions/session-life-creation';
import { attachInteractive } from './live-feed';
import { timelineFactory } from './record-timeline';
import { indexSource, journalOnly, locateRow, readSessionRow, recordReadable, remoteAnswerFor, summaryRuntime } from './session-rows';

/**
 * 宿主侧会话时间线服务。
 *
 * 一条会话一个 timeline 实例，**按 conversationId 缓存并引用计数**：桌面渲染层和手机看的是
 * 同一份（同一个 epoch、同一份结算），❌ 不是各开一份各读一遍文件 —— 两份实例意味着两个游标世代，
 * 而「谁先答谁生效」的 CAS 只在同一个实例里成立。没人订阅之后不立刻拆：一次刷新、一次切页
 * 都会把引用降到 0 再升回来，立刻拆 = 每次都整份重读。
 *
 * 一份 timeline 的内容 = 记录(`record-timeline.ts`)+ journal + 运行时状态(`live-feed.ts`);这个文件只管缓存与引用计数。
 */

const IDLE_DISPOSE_MS = 60_000;

export type SessionTimelineFailure = { code: string; message: string; admission?: SessionInputAdmission };
export type SessionTimelineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionTimelineFailure };

export function fail<T>(code: string, message: string): SessionTimelineResult<T> {
  return { ok: false, error: { code, message } };
}

export type TimelineEntry = {
  conversationId: string;
  timeline: SessionTimeline;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 活运行时里那条「谁在等人回答、谁在排队」的订阅（只有 ACP 腿有）。
   * `disposed` 是给那场赛跑用的：接上来之前这份 entry 可能已经被拆了。
   */
  pendingWatch: SessionStateWatch | null;
  /** What the live runtime last reported waiting (an ACP session's own approvals); the host's asks are added to it (D-31). */
  runtimeRequests: readonly PendingRequest[];
  disposed: boolean;
  /**
   * 没有记录可读时的替身(见 stand-in-timeline.ts)。它**不进缓存**:真记录一出现,下一次 acquire
   * 就该开真时间线,而缓存里的替身会把它挡住。用完即拆。
   */
  standIn?: boolean;
  /** Stops keeping the session index current from this timeline (`followSessionIndex`). */
  stopIndex?: () => void;
  /** The agent session whose record this timeline reads; null = journal only. */
  providerSessionId: string | null;
  /** Out of the cache because the row moved to another record; disposed when its last holder lets go. */
  evicted?: boolean;
};

export const entries = new Map<string, TimelineEntry>();
const opening = new Map<string, Promise<TimelineEntry>>();
/** 每次整体重置 +1 —— 用来认出「开到一半、代已经翻篇」的那些 timeline。 */
export let resetGeneration = 0;

/** How a failed record source reaches the subscriptions reading it; `subscriptions.ts` registers it (it imports this file, not the other way). */
let recordFailed: (conversationId: string, error: unknown) => void = () => {};
export function onRecordSourceFailed(handler: (conversationId: string, error: unknown) => void): void {
  recordFailed = handler;
}

// ─── timeline 缓存 ──────────────────────────────────────────────────────────

function disposeEntry(entry: TimelineEntry): void {
  entry.disposed = true;
  try {
    entry.pendingWatch?.dispose();
  } catch (error) {
    log.warn('sessionTimeline: pending-permission watch dispose failed', {
      conversationId: entry.conversationId,
      error: String(error),
    });
  }
  entry.pendingWatch = null;
  entry.stopIndex?.();
  entry.timeline.dispose();
}

function scheduleIdleDispose(entry: TimelineEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.refs > 0) return;
    if (entries.get(entry.conversationId) === entry) entries.delete(entry.conversationId);
    try {
      disposeEntry(entry);
    } catch (error) {
      log.warn('sessionTimeline: dispose failed', {
        conversationId: entry.conversationId,
        error: String(error),
      });
    }
  }, IDLE_DISPOSE_MS);
  // 空闲拆除不该拖住进程退出。
  entry.idleTimer.unref?.();
}

export async function acquire(conversationId: string): Promise<SessionTimelineResult<TimelineEntry>> {
  const row = readSessionRow(conversationId);
  if (!row) return fail('session_not_found', `这台机器上没有会话 ${conversationId}`);
  let cached = entries.get(conversationId);
  // @@@record-moved - a model switch across billing routes forks the agent session onto a new record
  // (reloadEmdashSession); the cached timeline still reads the old one and would never show the next turn.
  const providerSessionId = row.providerSessionId?.trim();
  if (cached?.providerSessionId && providerSessionId && cached.providerSessionId !== providerSessionId) {
    evict(cached);
    cached = undefined;
  }
  if (cached) {
    cached.refs += 1;
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = null;
    }
    return { ok: true, value: cached };
  }

  const location = locateRow(row);
  // An ACP session's journal holds the turns gugu adds to it, and all its turns when its agent keeps no record gugu reads.
  const journal = summaryRuntime(row.runtime) === 'acp' ? journalLocator(conversationId) : null;
  if (!location.supported && !(journal && journalOnly(row))) {
    // 没有记录可读也要打得开(spec session-always-openable):给一个只含第一句话的替身,
    // 为什么、怎么再试由各端按会话摘要画在转录末尾。❌ 回 record_unsupported 让它变成一行点不开的灰字。
    return { ok: true, value: standInEntry(row) };
  }
  if (journal) await ensureJournal(conversationId);
  if (!timelineFactory) {
    return fail(
      'timeline_unavailable',
      '会话记录源还没有装进宿主（setSessionTimelineFactory 未调用）'
    );
  }

  // 并发的两次 acquire 只开一份实例：两份实例 = 两个 epoch，游标当场作废。
  // ⚠️ 等待那一支同样要把拒绝收敛成 Result —— 让它抛穿过去，第二个调用方拿到的就是一个
  //    异常而不是带 code 的失败，而第一个调用方拿到的是规规矩矩的 `{ok:false}`。
  const inFlight = opening.get(conversationId);
  if (inFlight) {
    try {
      const entry = await inFlight;
      entry.refs += 1;
      return { ok: true, value: entry };
    } catch (error) {
      return openFailure(error);
    }
  }

  const factory = timelineFactory;
  // 开到一半被 reset 掉的那一份不许再登记（否则拆完之后又冒出来一个没人拆的实例）。
  const generation = resetGeneration;
  // 审批只有 ACP 腿有可结算的请求 id；TUI 腿的审批画在终端里，没有通道
  // （`write-bridge` 对它 fail loud）。所以这条订阅只对 ACP 腿开。
  const promise = factory({ locator: location.supported ? location.locator : null, journal, conversationId, answerableQuestions: remoteAnswerFor(row),
    onError: error => recordFailed(conversationId, error) }).then((timeline) => {
    if (generation !== resetGeneration) {
      timeline.dispose();
      throw new Error('会话时间线服务在这份记录打开的过程中被重置了');
    }
    const entry: TimelineEntry = {
      conversationId,
      timeline,
      refs: 1,
      idleTimer: null,
      pendingWatch: null,
      runtimeRequests: [],
      disposed: false,
      providerSessionId: location.supported ? location.locator.providerSessionId : null,
    };
    entries.set(conversationId, entry);
    try {
      attachInteractive(entry, row);
      if (!row.archivedAt) entry.stopIndex = followSessionIndex(conversationId, timeline, () => indexSource(row, location));
    }
    catch (error) { entries.delete(conversationId); timeline.dispose(); throw error; }
    return entry;
  });
  opening.set(conversationId, promise);
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return openFailure(error);
  } finally {
    if (opening.get(conversationId) === promise) opening.delete(conversationId);
  }
}

/** 会话行上的建立时间(SQLite `CURRENT_TIMESTAMP`,UTC)→ epoch ms;读不出来 = 不知道。 */
function rowCreatedAt(row: SessionRow): number | null {
  const raw = row.createdAt?.trim();
  if (!raw) return null;
  const at = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? at : null;
}

/**
 * 这个人发出去的第一句话:还没投出去的首轮(聊天腿),或者建会话时记下的那句(终端腿)。
 * 聊天腿的首轮一入队就是会话的 pending 行,各端从那一行画它(连同发送、启动、失败的状态);那一行还在时,
 * 替身 ❌ 再带一份 —— 同一句话会画成两个气泡。
 */
function firstMessageOf(row: SessionRow): string | null {
  const session = mapSessionRowToSession(row);
  const first = session.initialQueue?.[0];
  if (!first) return session.firstUtterance ?? null;
  const messageId = creationMessageId(session, 0);
  return sessionLife().read(row.id).pending.items.some((item) => item.messageId === messageId) ? null : first.text;
}

function standInEntry(row: SessionRow): TimelineEntry {
  return {
    conversationId: row.id,
    timeline: createStandInTimeline({
      sessionId: row.id,
      firstMessage: firstMessageOf(row),
      createdAt: rowCreatedAt(row),
      recordAvailable: () => recordReadable(row.id),
    }),
    refs: 1,
    idleTimer: null,
    pendingWatch: null,
    runtimeRequests: [],
    disposed: false,
    standIn: true,
    providerSessionId: null,
  };
}

/** `resetSessionTimelineService`, before the subscriptions go. */
export function beginEntriesReset(): void {
  // 存档跟着一起作废:重置意味着「这一层记的东西可能都不作数了」,
  // 留着一份自称还对得上的存档,下次开会话就会拿它去续一段不存在的历史。
  for (const id of entries.keys()) void dropTimelineArchive(id);
  resetGeneration += 1;
  opening.clear();
}

/** `resetSessionTimelineService`, after the subscriptions went. */
export function disposeAllEntries(): void {
  for (const entry of [...entries.values()]) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entries.delete(entry.conversationId);
    try {
      disposeEntry(entry);
    } catch {
      // 收尾路径：拆一个实例失败不该拦住拆别的。
    }
  }
}

function openFailure<T>(error: unknown): SessionTimelineResult<T> {
  // 「记录不在这台机器上」与「记录在但读不动」是两件事：前者用户能自己判断（会话是在别处跑的），
  // 后者是本机故障。合成一个 code 就把这条判断从用户手里拿走了。
  const code =
    (error as Error)?.name === 'SessionRecordNotFoundError' ? 'record_not_found' : 'record_unreadable';
  return fail(code, (error as Error)?.message ?? String(error));
}

export function evict(entry: TimelineEntry): void {
  entries.delete(entry.conversationId);
  entry.evicted = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  if (entry.refs <= 0) disposeEntry(entry);
}

export function release(entry: TimelineEntry): void {
  entry.refs -= 1;
  if (entry.evicted) {
    if (entry.refs <= 0 && !entry.disposed) disposeEntry(entry);
    return;
  }
  if (entry.standIn) {
    if (entry.refs <= 0 && !entry.disposed) {
      entry.disposed = true;
      entry.timeline.dispose();
    }
    return;
  }
  if (entry.refs > 0) return;
  entry.refs = 0;
  scheduleIdleDispose(entry);
}

export async function withTimeline<T>(
  conversationId: string,
  use: (timeline: SessionTimeline, floor: string | null) => T | Promise<T>
): Promise<SessionTimelineResult<T>> {
  const acquired = await acquire(conversationId);
  if (!acquired.ok) return acquired;
  try {
    const floor = await nativeConversationHistoryFloor(conversationId);
    return { ok: true, value: clearedHistoryResult(await use(acquired.value.timeline, floor), floor) };
  } catch (error) {
    return fail('timeline_failed', (error as Error)?.message ?? String(error));
  } finally {
    release(acquired.value);
  }
}
