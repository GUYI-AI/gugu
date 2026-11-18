import { useTranslation } from 'react-i18next'
import type { QuestionAnswer, SettlementQuestion } from '@gugu/session-core/session-record/contract'
import { Button } from '../ui/Button'

/** The same labels appear in the final review and in the host's confirmed receipt. */
export function AgentQuestionAnswers({ questions, answers, busy = false, onEdit }: {
  questions: readonly SettlementQuestion[]
  answers: readonly QuestionAnswer[]
  busy?: boolean
  onEdit?: (index: number) => void
}) {
  const { t } = useTranslation('assistant')
  return <div className="agent-question-card__answers">
    {questions.map((question, index) => {
      const answer = answers[index]!
      const labels = answer.selected.map(id => question.options.find(option => option.optionId === id)!.name)
      if (answer.other?.trim()) labels.push(answer.other.trim())
      return <div className="agent-question-card__answer" key={index}>
        <div className="agent-question-card__answer-head">
          <span>{question.header || question.question}</span>
          {onEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onEdit(index)}>{t('question.edit')}</Button>}
        </div>
        <p>{labels.join(t('question.answerSeparator')) || t('question.noSelection')}</p>
      </div>
    })}
  </div>
}
