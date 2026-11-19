import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { Button } from '../ui/Button'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionAnswer, Settlement, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract'
import { useToast } from '../toastContext'
import { Markdown } from '../markdown/Markdown'
import { agentQuestionDraftKey, questionAnswerReady } from '../../lib/agentQuestion'
import { AgentQuestionAnswers } from './AgentQuestionAnswers'
import '../../i18n/registerAssistantCatalog'
import './agent-question-card.css'

type Draft = { step: number; answers: QuestionAnswer[]; custom: boolean[]; deferred: boolean; reviewing: boolean }
const drafts = new Map<string, Draft>()

/** The host settles once; selecting or deferring never sends an answer. */
type AgentQuestionCardProps = {
  scope: string
  settlement: Settlement
  unavailable?: boolean
  mobile?: boolean
  /** The chat message supplies the single outer frame and title. */
  embedded?: boolean
  respond: (answers: readonly QuestionAnswer[]) => Promise<SessionpageSessionRespondResult>
}

export function AgentQuestionCard(props: AgentQuestionCardProps) {
  return <QuestionFlow key={agentQuestionDraftKey(props.scope, props.settlement)} {...props} />
}

function QuestionFlow({ scope, settlement, unavailable = false, mobile = false, embedded = false, respond }: AgentQuestionCardProps) {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const questions = settlement.questions ?? []
  const key = agentQuestionDraftKey(scope, settlement)
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? {
    step: 0, answers: questions.map(() => ({ selected: [] })), custom: questions.map(() => false), deferred: false, reviewing: false,
  })
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [accepted, setAccepted] = useState(false)
  const [observed, setObserved] = useState<Settlement | null>(null)
  const update = (next: Draft) => { drafts.set(key, next); setDraft(next) }
  const current = observed ?? settlement
  useEffect(() => { if (current.state !== 'pending') drafts.delete(key) }, [key, current.state])
  if (current.state !== 'pending' || accepted) return null
  if (questions.length === 0) return null
  if (draft.deferred) return <div className="agent-question-receipt" data-testid="agent-question-deferred">
    <span>{t('question.waiting')}</span><Button variant="ghost" size="sm" onClick={() => update({ ...draft, deferred: false })}>{t('question.resume')}</Button>
  </div>
  const question = questions[draft.step]!
  const answer = draft.answers[draft.step]!
  const replaceAnswer = (next: QuestionAnswer, custom: boolean) => update({ ...draft,
    answers: draft.answers.map((old, index) => index === draft.step ? next : old),
    custom: draft.custom.map((old, index) => index === draft.step ? custom : old),
  })
  const ready = questionAnswerReady(question, answer, draft.custom[draft.step] ?? false)
  const submit = async () => {
    if (submitting.current || unavailable || !draft.reviewing || !questions.every((item, index) => questionAnswerReady(item, draft.answers[index]!, draft.custom[index] ?? false))) return
    submitting.current = true
    setBusy(true)
    try {
      const result = await respond(draft.answers)
      if (result.accepted) { setAccepted(true); drafts.delete(key) }
      else { setObserved(result.settlement); toast(t('question.noLongerWaiting'), 'info') }
    } catch (error) { rendererLogger('actions/AgentQuestionCard').error({ error: error }, 'action failed'); toast(t('question.failed'), 'error', messageForUser(error)) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <section className="agent-question-card" aria-label={t('question.title')} data-mobile={mobile || undefined} data-embedded={embedded || undefined} data-testid="agent-question-card" aria-busy={busy}>
    <div className="agent-question-card__head">{(!embedded || draft.reviewing) && <span>{t(draft.reviewing ? 'question.reviewTitle' : 'question.title')}</span>}<span>{t('question.count', { count: questions.length })}</span></div>
    <p className="agent-question-card__hint">{t(draft.reviewing ? 'question.reviewHint' : 'question.flowHint')}</p>
    {!draft.reviewing && <>
    <div className="agent-question-card__progress" role="progressbar" aria-label={t('question.progress')} aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={draft.step + 1}>
      {questions.map((_, index) => <span key={index} data-complete={index <= draft.step || undefined} />)}
    </div>
    <div className="agent-question-card__step"><span>{draft.step + 1} / {questions.length}</span><span>{question.header}</span><span>{t(question.multiSelect ? 'question.multiSelect' : 'question.singleSelect')}</span></div>
    <div className="agent-question-card__question"><Markdown trust="chat" content={question.question} /></div>
    <div className="agent-question-card__options" role="group" aria-label={question.question}>
      {question.options.map((option) => <Button variant="ghost" size="sm" key={option.optionId} className="agent-question-card__option"
        aria-pressed={answer.selected.includes(option.optionId)} disabled={busy || unavailable}
        onClick={() => replaceAnswer({ selected: question.multiSelect
          ? answer.selected.includes(option.optionId) ? answer.selected.filter((id) => id !== option.optionId) : [...answer.selected, option.optionId]
          : [option.optionId], ...(question.multiSelect && answer.other ? { other: answer.other } : {}) }, question.multiSelect && draft.custom[draft.step] === true)}>
        <span className="agent-question-card__label">{option.name}</span>{option.description && <span className="agent-question-card__detail">{option.description}</span>}
      </Button>)}
      <Button variant="ghost" size="sm" className="agent-question-card__option" aria-pressed={draft.custom[draft.step]}
        disabled={busy || unavailable} onClick={() => {
          const custom = !question.multiSelect || !draft.custom[draft.step]
          replaceAnswer({ selected: question.multiSelect ? answer.selected : [], ...(custom ? { other: answer.other ?? '' } : {}) }, custom)
        }}>
        <span className="agent-question-card__label">{t('question.other')}</span>
      </Button>
    </div>
    {draft.custom[draft.step] && <textarea className="agent-question-card__custom" aria-label={t('question.other')} value={answer.other ?? ''}
      disabled={busy || unavailable} onChange={(event) => replaceAnswer({ ...answer, other: event.target.value }, true)} autoFocus />}
    </>}
    {draft.reviewing && <AgentQuestionAnswers questions={questions} answers={draft.answers} busy={busy}
      onEdit={index => update({ ...draft, step: index, reviewing: false })} />}
    {unavailable && <p className="agent-question-card__unavailable" role="status">{t('question.unavailable')}</p>}
    <div className="agent-question-card__footer">
      <Button variant="ghost" size="sm" className="agent-question-card__later" disabled={busy} onClick={() => update({ ...draft, deferred: true })}>{t('question.later')}</Button>
      {(draft.reviewing || draft.step > 0) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => update({ ...draft, step: draft.reviewing ? draft.step : draft.step - 1, reviewing: false })}>{t(draft.reviewing ? 'question.back' : 'question.previous')}</Button>}
      <Button variant="primary" size="sm" className="agent-question-card__submit" disabled={(!draft.reviewing && !ready) || busy || unavailable}
        onClick={() => draft.reviewing ? void submit() : draft.step < questions.length - 1 ? update({ ...draft, step: draft.step + 1 }) : update({ ...draft, reviewing: true })}>
        {t(busy ? 'question.submitting' : draft.reviewing ? 'question.submit' : draft.step < questions.length - 1 ? 'question.next' : 'question.review')}
      </Button>
    </div>
  </section>
}
