import { describe, expect, it } from 'vitest'
import { readQuestionAnswerDelivery } from './question-answer'

describe('serialized question answer reading', () => {
  it.each([null, { selected: 42 }, { selected: [1] }, { selected: [], other: 42 }])('ignores malformed answer rows %j', (answer) => {
    const json = JSON.stringify({ state: 'answered', answers: [answer] })
    expect(readQuestionAnswerDelivery(`<gugu_question_answer>\n${json}\n</gugu_question_answer>`)).toBeUndefined()
  })
  it.each(['null', '[]', '42', '"answered"'])('ignores a non-object envelope %s', (json) => {
    expect(readQuestionAnswerDelivery(`<gugu_question_answer>\n${json}\n</gugu_question_answer>`)).toBeUndefined()
  })
})
