import { ask } from '../asks';
import { hostAsks } from '../asks/ask';
import { askSourceSpec } from '../asks/sources';
import { readAgentQuestionRecords, rememberAgentQuestion } from '../sessions/agent-question-store';
import { deliverAgentQuestionAnswer, restoredAgentQuestion } from '../sessions/agent-question-delivery';
import { isVisibleQueuedPrompt } from '@shared/core/sessions/visible-queued-prompt';
import { conversationQueueText } from '@shared/core/sessions/conversation-queue-text';
import { type SessionRow } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { watchSessionState } from './live-permissions';
import { summaryRuntime } from './session-rows';
import type { TimelineEntry } from './timeline-entries';

/** 实时流:运行时那一半(待答、排队、直播回复、终端、运行中的一轮)怎么进 timeline。 */

/**
 * 把活运行时里待答的审批接进这条时间线。
 *
 * ⚠️ **不挡住 acquire**：`replica.ready` 等的是 ACP 运行时进程那一头。读侧读的是磁盘上的记录，
 * 与那个进程活得好不好无关 —— 让它去 await，等于一个卡住的运行时进程能把「看会话内容」
 * 一起拖死。接不上就 warn 一句，时间线照常可读，只是没有审批卡（与接这条之前的行为一致）。
 */
function attachPendingRequests(entry: TimelineEntry): void {
  void watchSessionState(entry.conversationId, (requests, queuedPrompts, liveReply, terminals, activeTurn) => {
    if (entry.disposed) return;
    entry.runtimeRequests = requests;
    syncPending(entry);
    entry.timeline.syncQueuedPrompts(queuedPrompts.filter(isVisibleQueuedPrompt).map(prompt => ({ ...prompt, text: conversationQueueText(prompt.text) })));
    entry.timeline.syncLiveReply(liveReply ?? null);
    entry.timeline.syncTerminals(terminals);
    entry.timeline.syncActiveTurn(activeTurn ?? null);
  })
    .then((watch) => {
      if (!watch) return;
      // 接上来之前这份 entry 可能已经被拆了 —— 那就当场把订阅也拆掉，❌ 别留一条没人拆的。
      if (entry.disposed) {
        watch.dispose();
        return;
      }
      entry.pendingWatch = watch;
    })
    .catch((error) => {
      log.warn('sessionTimeline: failed to watch pending permissions', {
        conversationId: entry.conversationId,
        error: String(error),
      });
    });
}

export function syncPending(entry: TimelineEntry): void {
  if (entry.disposed || entry.standIn) return;
  const asked = [...(hostAsks.get(entry.conversationId)?.values() ?? [])].map((ask) => ask.request);
  entry.timeline.syncPendingRequests([...entry.runtimeRequests, ...asked]);
}

/**
 * Process-bound approvals live as long as the host that asked them. One the archive brings back still pending,
 * with no such ask here, was asked by a process that is gone: nobody waits on its answer, so it is over (10-06 A/B: after B
 * restarted, the private chat's band kept 「允许 Claude 1 要装 插件探针 r1」, which nothing would ever take). The archive keeps
 * no `liveItemIds`, so the runtime's next sync cannot withdraw it either. Agent questions instead restore their
 * answer handler from the archived card and use the existing idempotent session outbox.
 */
function restoreAgentQuestions(entry: TimelineEntry, projectId: string): void {
  void import('../asks/human-tool-wait').then(({ restoreHumanToolResults }) => restoreHumanToolResults(entry.conversationId, projectId))
    .catch(error => log.error('Human tool results could not be restored', { conversationId: entry.conversationId, error: String(error) }));
  const saved = new Map(readAgentQuestionRecords(entry.conversationId).map(item => [item.itemId, item]));
  for (const item of entry.timeline.getSnapshot({ limit: 1 }).settlements) {
    if (!saved.has(item.itemId) && restoredAgentQuestion(item)) { rememberAgentQuestion(entry.conversationId, item); saved.set(item.itemId, item); }
  }
  for (const settlement of saved.values()) {
    if (settlement.state === 'cancelled') { entry.timeline.cancelSettlement(settlement.itemId); continue; }
    if (hostAsks.get(entry.conversationId)?.has(settlement.itemId)) continue;
    const restored = restoredAgentQuestion(settlement);
    if (!restored) continue;
    if (restored.answer) {
      entry.timeline.syncPendingRequests([...entry.runtimeRequests, ...[...(hostAsks.get(entry.conversationId)?.values() ?? [])].map(ask => ask.request), restored.request]);
      entry.timeline.settle({ itemId: restored.request.itemId, optionId: settlement.optionId, by: settlement.resolvedBy ?? 'owner' });
    }
    const answer = restored.answer ? Promise.resolve(restored.answer) : ask(entry.conversationId, restored.request,
      { signal: new AbortController().signal });
    deliverAgentQuestionAnswer(entry.conversationId, projectId, restored.request, restored.answerMessageId, answer);
  }
}

function withdrawOrphanHostAsks(entry: TimelineEntry): void {
  const asked = hostAsks.get(entry.conversationId);
  for (const settlement of entry.timeline.getSnapshot({ limit: 1 }).settlements) {
    if (settlement.state !== 'pending' || !settlement.origin) continue;
    const source = askSourceSpec(settlement.origin.source);
    // An archived request can outlive the feature that created its source.
    if (!source || (source.raisedBy === 'host' && !asked?.has(settlement.itemId))) {
      entry.timeline.cancelSettlement(settlement.itemId);
    }
  }
}

export function attachInteractive(entry: TimelineEntry, row: SessionRow): void {
  restoreAgentQuestions(entry, row.projectId);
  if (summaryRuntime(row.runtime) === 'acp') attachPendingRequests(entry);
  withdrawOrphanHostAsks(entry);
  if (hostAsks.has(row.id)) syncPending(entry);
}
