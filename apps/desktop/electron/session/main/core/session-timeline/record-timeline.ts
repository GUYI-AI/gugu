import { ptyTurnEnds, recordPtyEngineEnd } from '../sessions/pty-turn-ends';
import { sessionEngine, sessionProcess } from '../sessions/session-process';
import { nativePromptReceipt } from '../sessions/native-prompt-receipts';
import {
  type RecordLineageNode,
  type SessionRecordLocator,
  type SessionTimeline,
} from '@gugu/session-core/session-record';
import { log } from '@main/lib/logger';
import {
  pruneTimelineArchives,
  timelineArchiveFile,
} from './archive-store';
import { createFoldClient, type FoldClient } from './fold-client';
import { readSessionRow } from './session-rows';

/** 记录源:一条会话的记录 + journal 怎么开成 timeline(`setSessionTimelineFactory` 换实现)。 */

/**
 * 造 timeline 的口。实现归 `packages/session-core/src/session-record`（记录源 + timeline），
 * 这一层只负责「谁在看、看的是哪一条、谁答过了」。
 * 显式置 null = fail loud（`timeline_unavailable`），❌ 不返回空时间线冒充「这条会话没内容」。
 */
export type SessionTimelineFactory = (input: {
  onError?: (error: unknown) => void;
  /** The agent's record; null = it has none gugu reads, and the journal is all there is. */
  locator: SessionRecordLocator | null;
  /** Gugu's journal of the session (`session-journal.ts`), read beside the record. */
  journal?: SessionRecordLocator | null;
  conversationId: string;
  /** 记录里认出来的提问宿主能不能代答(#6798);能 ⇒ 提问结算带上整份题目。 */
  answerableQuestions?: boolean;
  readMode?: 'snapshot';
  parentLineage?: readonly RecordLineageNode[];
}) => Promise<SessionTimeline>;

/**
 * 默认实现走**动态 import**：那个 barrel 往下拖 node:fs 与 better-sqlite3，静态引进来
 * 会让每一个只想测服务层记账的用例都替记录源交税（也会把原生模块拖进不需要它的进程）。
 * 真开一份时间线的那一刻才加载。
 */
const defaultTimelineFactory: SessionTimelineFactory = async ({ locator, journal, conversationId: sessionId, answerableQuestions, readMode, parentLineage, onError }) => {
  const { createSessionRecordSource, createSessionTimeline, emptyRecordSource } = await import(
    '@gugu/session-core/session-record'
  );
  const own = locator ?? journal;
  if (!own) throw new Error(`session ${sessionId}: neither a record nor a journal to read`);
  // 存档只是捷径:读不出来 / 对不上,`createSessionTimeline` 自己会退回整份重读。
  const archive = !locator || readMode === 'snapshot' ? null : await foldedArchive({ locator, sessionId, parentLineage, answerableQuestions });
  const row = readSessionRow(sessionId, { includeArchived: true });
  const pty = row && row.runtime !== 'acp';
  const source = locator ? createSessionRecordSource(locator, { readMode, parentLineage }) : emptyRecordSource(own);
  const timeline = await createSessionTimeline(source, {
    onError,
    sessionId,
    ...(pty && locator ? { hostTurnEnds: ptyTurnEnds(sessionId, locator.providerSessionId) } : {}),
    archive,
    ...(journal ? { journal: createSessionRecordSource(journal) } : {}),
    ...(answerableQuestions ? { answerableQuestions } : {}),
    hostPrompts: (digest) => nativePromptReceipt(sessionId, digest),
  });
  try {
    // Observe only an uncovered native turn. Reopening an ended record must not create new end facts.
    const last = timeline.getSnapshot().turns.at(-1);
    if (pty && locator && last && !last.outcome && last.startedAt !== undefined
      && row.agentStatus !== 'working' && row.agentStatus !== 'needs_user' && await sessionEngine(sessionId) === 'gone') {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      if (latest?.providerSessionId === locator.providerSessionId && latest.runtime !== 'acp'
        && latest.agentStatus !== 'working' && latest.agentStatus !== 'needs_user' && !sessionProcess(sessionId)) {
        recordPtyEngineEnd(sessionId, Date.now(), true, last.startedAt);
      }
    }
    return timeline;
  } catch (error) {
    timeline.dispose();
    throw error;
  }
};

let foldClient: FoldClient | null = null;

/** The record folded on the fold thread (`fold.ts`); if that thread fails, the timeline folds the record here. */
async function foldedArchive(input: { locator: SessionRecordLocator; sessionId: string; parentLineage?: readonly RecordLineageNode[]; answerableQuestions?: boolean }) {
  const checkpoint = timelineArchiveFile(input.sessionId);
  if (!checkpoint) return null;
  try {
    const archive = await (foldClient ??= createFoldClient((message, detail) => log.warn(message, detail))).fold({
      locator: input.locator,
      sessionId: input.sessionId,
      checkpoint,
      ...(input.parentLineage ? { parentLineage: input.parentLineage } : {}),
      ...(input.answerableQuestions ? { answerableQuestions: true } : {}),
    });
    void pruneTimelineArchives();
    return archive;
  } catch (error) {
    log.warn('sessionTimeline: fold thread failed; folding on the main thread', { sessionId: input.sessionId, error: String(error) });
    return null;
  }
}

export let timelineFactory: SessionTimelineFactory | null = defaultTimelineFactory;

export function setSessionTimelineFactory(next: SessionTimelineFactory | null): void {
  timelineFactory = next;
}
