import type { Settlement } from '@gugu/session-core/session-record/contract';
import { parseQuestionAnswers } from '@gugu/session-core/session-record/question-answer';
import { isQuestionCardSettlement, type QuestionCardResult } from '@gugu/core/shared/ui/taskCardModels';
import { publicQuestionCard } from '../session/main/core/sessions/agent-question-model';

type Auth = { userId: string; accessToken: string };
type Record = { sessionId: string; item: Settlement };

export function publicQuestionResult(item: Settlement): QuestionCardResult | null {
  if (item.state === 'cancelled') return { state: 'withdrawn' };
  if (item.state !== 'resolved') return null;
  if (item.optionId === 'discuss') return { state: 'discuss' };
  const answers = parseQuestionAnswers(item.optionId ? JSON.parse(item.optionId) : null);
  if (!answers) throw new Error('Settled question answers are unreadable');
  return { state: 'answered',answers };
}

/** The host's durable records are the outbox: a restart or failed RPC cannot lose a terminal card update. */
export function createQuestionCardSync(deps: {
  auth: () => Promise<Auth | null>;
  records: () => Record[];
  publish: (auth: Auth, messageId: string, result: QuestionCardResult) => Promise<unknown>;
  committed: (record: Record) => void;
  failed: (error: unknown) => void;
}) {
  let flight: Promise<void> | null = null, again = false, waiting = false, stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (flight) { again = true; return flight; }
    if (retry) { clearTimeout(retry); retry = null; }
    flight = (async () => {
      do {
        again = false; waiting = false;
        const auth = await deps.auth();
        if (!auth || stopped) return;
        for (const record of deps.records()) {
          const card = publicQuestionCard(record.item.origin?.payload);
          if (!card || card.synced || card.ownerUserId !== auth.userId || record.item.state === 'pending') continue;
          try {
            const result = publicQuestionResult(record.item);
            if (!result) continue;
            const current = await deps.auth();
            if (!current || current.userId !== auth.userId || stopped) return;
            const confirmed = await deps.publish(current,card.messageId,result);
            if (!isQuestionCardSettlement(confirmed) || confirmed.state !== result.state) throw new Error('Question card settlement was not confirmed');
            if (result.state === 'answered' && (confirmed.state !== 'answered' || confirmed.answers.length !== result.answers.length
              || confirmed.answers.some((answer,index) => JSON.stringify([answer.selected,answer.other ?? '',answer.skipped === true])
                !== JSON.stringify([result.answers[index].selected,result.answers[index].other ?? '',result.answers[index].skipped === true])))) throw new Error('Question card already has different answers');
            deps.committed(record);
          } catch (error) { waiting = true; deps.failed(error); }
        }
      } while (again && !stopped);
    })().catch(error => { waiting = true; deps.failed(error); }).finally(() => {
      flight = null;
      if (waiting && !stopped) { retry = setTimeout(() => { retry = null; void wake(); },30_000); retry.unref?.(); }
    });
    return flight;
  };
  return { wake, cloudAnswered: () => { if (waiting && !flight && !retry) void wake(); }, stop: () => { stopped = true; if (retry) clearTimeout(retry); } };
}
