import type { QuestionAnswer, Settlement, SettlementQuestion } from '@gugu/session-core/session-record/contract'

/** Pending questions take precedence. Keep only the latest discussion receipt when nothing else is waiting. */
export function latestAgentQuestion(settlements: Readonly<Record<string, Settlement>>): Settlement | null {
  const questions = Object.values(settlements).filter((item) => item.kind === 'question' && (item.questions?.length ?? 0) > 0)
  const pending = questions.find((item) => item.state === 'pending')
  if (pending) return pending
  const latest = questions.reduce<Settlement | null>((newest, item) => !newest || (item.askedAt ?? item.resolvedAt ?? 0) >= (newest.askedAt ?? newest.resolvedAt ?? 0) ? item : newest, null)
  return latest?.state === 'resolved' && latest.optionId === 'discuss' ? latest : null
}

export function questionAnswerReady(question: SettlementQuestion, answer: QuestionAnswer, custom: boolean): boolean {
  if (answer.skipped === true) return !custom && answer.selected.length === 0 && !answer.other?.trim()
  if (custom && !answer.other?.trim()) return false
  if (answer.selected.some((id) => !question.options.some((option) => option.optionId === id))) return false
  return question.multiSelect || answer.selected.length === 1 || Boolean(answer.other?.trim())
}

/** A provider may finish streaming the question input under the same tool-call id. Never reuse an answer for changed words. */
export function agentQuestionDraftKey(scope: string, settlement: Settlement): string {
  return JSON.stringify([scope, settlement.itemId, settlement.askedAt, settlement.questions, settlement.skippable, settlement.canDiscuss])
}
