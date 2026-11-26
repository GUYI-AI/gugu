import { readQuestionAnswerDelivery } from '@gugu/session-core/session-record/question-answer';
import type { ChatMessage } from '@session-chat/model';

type MessagePresentation =
  | { kind: 'question-answer'; reading: NonNullable<ChatMessage['questionAnswer']> }
  | { kind: 'body'; reading: undefined };

/** The row presenter's dispatch, for both raw records and normalized units. */
export function messagePresentation(item: ChatMessage): MessagePresentation {
  const reading = item.questionAnswer ?? (item.role === 'user' ? readQuestionAnswerDelivery(item.text) : undefined);
  if (reading) return { kind: 'question-answer', reading };
  return { kind: 'body', reading: undefined };
}

export function messageQuestionAnswer(item: ChatMessage): ChatMessage['questionAnswer'] {
  return messagePresentation(item).reading;
}
