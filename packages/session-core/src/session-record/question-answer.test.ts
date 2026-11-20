import { describe, expect, it } from 'vitest'
import type { QuestionAnswer } from './contract'
import { parseQuestionAnswers, questionAnswerError, questionAnswerText, readQuestionAnswerDelivery } from './question-answer'

const questions = [{ question: '选哪种？', multiSelect: false, options: [{ optionId: 'a', name: 'A' }] }]

describe('explicitly skipped answers', () => {
  it('accepts a skip while still rejecting an unanswered single-choice question', () => {
    expect(questionAnswerError(questions, [{ selected: [], skipped: true }])).toBeNull()
    expect(questionAnswerError(questions, [{ selected: [] }])).toBe('请回答每一道题')
    expect(questionAnswerError(questions, [])).not.toBeNull()
  })

  it.each([
    { selected: [], skipped: false }, { selected: [], skipped: 'true' },
    { selected: ['a'], skipped: true }, { selected: [], other: 'answer', skipped: true },
  ])('rejects a malformed or contradictory skip %j on write and read', answer => {
    expect(questionAnswerError(questions, [answer as QuestionAnswer])).not.toBeNull()
    expect(parseQuestionAnswers([answer])).toBeNull()
  })

  it('retains skipped in saved answers and in the session transcript', () => {
    const answers = [{ selected: [], skipped: true as const }, { selected: ['a'] }]
    expect(parseQuestionAnswers(JSON.parse(JSON.stringify(answers)))).toEqual(answers)
    expect(questionAnswerText(answers)).toBe('（已跳过） / a')
    expect(readQuestionAnswerDelivery(`<gugu_question_answer>\n${JSON.stringify({ state: 'answered', answers })}\n</gugu_question_answer>`)).toEqual({ answer: '（已跳过） / a' })
  })
})
