import { readQuestionAnswerDelivery } from '@gugu/session-core/session-record/question-answer';
import type { ChatMessage } from '@session-chat/model';

type MessagePresentation =
  | { kind: 'question-answer'; reading: NonNullable<ChatMessage['questionAnswer']>; pinSummary: false }
  | { kind: 'body'; reading: undefined; pinSummary: true };

/** The row presenter and pin collector share this dispatch, for both raw records and normalized units. */
export function messagePresentation(item: ChatMessage): MessagePresentation {
  const reading = item.questionAnswer ?? (item.role === 'user' ? readQuestionAnswerDelivery(item.text) : undefined);
  // This compact status row has no text bubble for a summary to repeat or hide behind.
  if (reading) return { kind: 'question-answer', reading, pinSummary: false };
  // Preserve existing body summaries, including the attachment-name summary of a bare attachment row.
  return { kind: 'body', reading: undefined, pinSummary: true };
}

export function messageQuestionAnswer(item: ChatMessage): ChatMessage['questionAnswer'] {
  return messagePresentation(item).reading;
}
