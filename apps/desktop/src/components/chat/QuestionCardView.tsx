import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionCard } from '@gugu/core/shared/ui/taskCardModels'
import type { Settlement, SettlementQuestion } from '@gugu/session-core/session-record/contract'
import { parseQuestionAnswers, questionAnswerError } from '@gugu/session-core/session-record/question-answer'
import { useTimelineSession } from '@/components/session-watch/use-timeline-session'
import { useDevicesStore } from '../../store/devicesContext'
import { useChatStore } from '../../store/chatContext'
import { useAuth } from '../../store/auth'
import { questionAnsweredText } from '../../lib/questionCardAnswer'
import { composerCardCopy } from '../../lib/composerCardCopy'
import { useAvatarIdentity } from '../../lib/avatarIdentity'
import { unknownMemberName } from '../../lib/memberFallbackName'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { AgentHarnessIcon } from '../AgentHarnessIdentity'
import { Button } from '../ui/Button'
import { openTaskCardSession } from './openTaskCardSession'
import { AgentQuestionCard } from './AgentQuestionCard'
import { AgentQuestionAnswers } from './AgentQuestionAnswers'
import { Markdown } from '../markdown/Markdown'
import '../../i18n/registerAssistantCatalog'

/**
 * gugu-dev#181 ⑨ 问题卡:agent 在群里问它的主人,引用它正回的那一条。与任务卡同一个面:是什么(右上时刻)、问题、选项、一行状态。
 * 待答时主人读会话结算；结束后宿主更新原消息，让同事及离线回来的设备读取同一份结果。
 * 主人的完整题目沿用同一宿主结算口,统一核对后提交；旧宿主没有完整题目时保留原有引用回答路径。
 * 群里的同事不读取主人的私有会话,仍只展示消息中公开的题目和选项。
 */
export function QuestionCardView({ card, chatId, messageId, agentUserId, time, mobile = false, readOnly = false }: {
  card: QuestionCard
  chatId: string
  messageId: string
  agentUserId: string
  time: ReactNode
  mobile?: boolean
  /** History (an old private chat): the question as it was asked, ❌ answer controls, ❌ a read of the owner's session. */
  readOnly?: boolean
}) {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const owner = useAvatarIdentity(card.ownerUserId)
  const ownerName = owner?.display_name || unknownMemberName()
  const { devices } = useDevicesStore()
  const device = devices.find((row) => row.device_id === card.deviceId)
  const addressedToMe = user?.id === card.ownerUserId
  const mine = !readOnly && addressedToMe && Boolean(device)
  const head = addressedToMe ? t(composerCardCopy.question.head, { ns: 'messaging' }) : t('question.needsOwner', { name: ownerName })
  const read = useTimelineSession(assistantTimelineClient(device?.is_current_device === true), mobile ? 'mobile' : 'desktop', card.deviceId, card.sessionId, mine && !card.settled)
  const settlement = read.timeline.settlements[card.questionId] ?? null
  if (card.settled) return <div className="question-message-card" data-testid="composer-card" data-card-type="question">
    <div className="question-message-card__head"><AgentHarnessIcon agentId={agentUserId} size={16} /><span>{head}</span><span>{time}</span></div>
    <div className="question-message-card__receipt" data-testid="agent-question-receipt">
      {card.settled.state === 'discuss' && card.questions?.length && <p className="question-message-card__state">{t('question.count', { count: card.questions.length })}</p>}
      <p className="question-message-card__state">{t(card.settled.state === 'answered' ? 'question.answered' : card.settled.state === 'discuss' ? 'question.discuss' : 'question.withdrawn')}</p>
      {card.settled.state === 'answered' && (card.questions
        ? <AgentQuestionAnswers questions={card.questions} answers={card.settled.answers} />
        : <p className="question-message-card__state">{questionAnsweredText(JSON.stringify(card.settled.answers))}</p>)}
    </div>
  </div>
  // The authoritative timeline already carries every question, including cards sent by older hosts.
  // Only the addressee reads that private timeline. Everyone else reads the public question snapshot.
  if (mine && settlement?.questions?.length && (read.link === 'ok' || settlement.state !== 'pending')) {
    const answers = settlement.state === 'resolved' ? parseQuestionAnswers(settlement.optionId ? safeAnswerJson(settlement.optionId) : null) : null
    const completeAnswers = answers && !questionAnswerError(settlement.questions, answers) ? answers : null
    return <div className="question-message-card" data-testid="composer-card" data-card-type="question">
      <div className="question-message-card__head"><AgentHarnessIcon agentId={agentUserId} size={16} /><span>{t(composerCardCopy.question.head, { ns: 'messaging' })}</span><span>{time}</span></div>
      {settlement.state === 'pending'
        ? <AgentQuestionCard scope={`${card.deviceId}:${card.sessionId}`} settlement={settlement} mobile={mobile} embedded unavailable={read.link !== 'ok'}
            onDiscuss={() => read.respond({ itemId: card.questionId, kind: 'question', discuss: true })}
            respond={answers => read.respond({ itemId: card.questionId, kind: 'question', answers })} />
        : <div className="question-message-card__receipt" data-testid="agent-question-receipt">
            {settlement.optionId === 'discuss' && <p className="question-message-card__state">{t('question.count', { count: settlement.questions.length })}</p>}
            <p className="question-message-card__state">{t(settlement.optionId === 'discuss' ? 'question.discuss' : settlement.state === 'resolved' ? 'question.answered' : 'question.withdrawn')}</p>
            {completeAnswers && <AgentQuestionAnswers questions={settlement.questions} answers={completeAnswers} />}
            {settlement.state === 'resolved' && settlement.optionId !== 'discuss' && !completeAnswers && <p className="question-message-card__state">{t('question.answerUnreadable')}</p>}
          </div>}
    </div>
  }
  if (card.questions?.length) return <div className="question-message-card" data-testid="composer-card" data-card-type="question">
    <div className="question-message-card__head"><AgentHarnessIcon agentId={agentUserId} size={16} /><span>{head}</span><span>{time}</span></div>
    <ReadonlyAgentQuestions questions={card.questions} mobile={mobile} />
    {!readOnly && <p className="question-message-card__waiting"><span aria-hidden="true" />{t('question.waitingForOwner', { name: ownerName })}</p>}
  </div>
  const openable = mine && device?.is_current_device === true && card.options.length === 0
  const interactiveTime = typeof time !== 'string'
  const Root = openable && !interactiveTime ? 'button' : 'div'
  return (
    <Root
      type={openable ? 'button' : undefined}
      role={openable && interactiveTime ? 'button' : undefined}
      tabIndex={openable && interactiveTime ? 0 : undefined}
      onKeyDown={openable && interactiveTime ? event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void openTaskCardSession(card) } } : undefined}
      data-openable={openable || undefined}
      data-testid="composer-card"
      data-card-type="question"
      title={openable ? t('message.taskCard.open', { ns: 'messaging' }) : undefined}
      onClick={openable ? () => openTaskCardSession(card) : undefined}
      className="box-border flex w-[300px] max-w-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-left data-[openable]:cursor-pointer data-[openable]:hover:border-[var(--border-strong)]"
    >
      <span className="flex h-6 items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-document)] border border-[var(--border)]">
          <AgentHarnessIcon agentId={agentUserId} size={13} />
        </span>
        <span className="text-[var(--font-body)] font-semibold">{t(composerCardCopy.question.head, { ns: 'messaging' })}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[var(--font-caption)] text-[var(--muted-fg)]">{time}</span>
      </span>
      <span className="line-clamp-6 whitespace-pre-wrap break-words text-[var(--font-prose)] leading-[var(--lh-prose)]">{card.text}</span>
      {card.options.length > 0 && <QuestionCardOptions card={card} chatId={chatId} messageId={messageId} answerable={mine && settlement?.state === 'pending'} />}
      {mine && <QuestionCardState settlement={settlement} inSession={card.options.length === 0} />}
    </Root>
  )
}

/** Public wording only: no private timeline, answer controls or inferred end state. */
function ReadonlyAgentQuestions({ questions, mobile }: { questions: readonly SettlementQuestion[]; mobile: boolean }) {
  const { t } = useTranslation('assistant')
  return <div className="agent-question-card" data-embedded="true" data-readonly="true" data-mobile={mobile || undefined} data-testid="question-card-readonly">
    <div className="agent-question-card__head"><span>{t('question.count', { count: questions.length })}</span></div>
    {questions.map((question, index) => <div className="agent-question-card__readonly-question" key={index}>
      <div className="agent-question-card__step"><span>{question.header}</span><span>{t(question.multiSelect ? 'question.multiSelect' : 'question.singleSelect')}</span></div>
      <div className="agent-question-card__question"><Markdown trust="chat" content={question.question} /></div>
      <div className="agent-question-card__options">
        {question.options.map(option => <div className="agent-question-card__option" key={option.optionId}>
          <span className="agent-question-card__label">{option.name}</span>{option.description && <span className="agent-question-card__detail">{option.description}</span>}
        </div>)}
        <div className="agent-question-card__option"><span className="agent-question-card__label">{t('question.other')}</span></div>
      </div>
    </div>)}
  </div>
}

function QuestionCardOptions({ card, chatId, messageId, answerable }: { card: QuestionCard; chatId: string; messageId: string; answerable: boolean }) {
  const { sendMessageToChat } = useChatStore('sendMessageToChat')
  const [sending, setSending] = useState(false)
  const pick = (option: string) => {
    setSending(true)
    void sendMessageToChat(chatId, option, { replyToMessageId: messageId }).finally(() => setSending(false))
  }
  return (
    <span className="flex flex-wrap gap-1">
      {card.options.map((option) => (
        <Button key={option} variant="secondary" size="sm" disabled={!answerable || sending} onClick={() => pick(option)}>{option}</Button>
      ))}
    </span>
  )
}

/** 一行状态:待你回答 = 琥珀点(与侧栏「需要你」同一个色调);答了 =「已回答：X」;收回了 = 这次提问已结束。 */
function QuestionCardState({ settlement, inSession }: { settlement: Settlement | null; inSession: boolean }) {
  const { t } = useTranslation('assistant')
  if (!settlement) return null
  if (settlement.state === 'pending') {
    return (
      <span className="flex h-5 items-center gap-2 text-[var(--font-caption)] text-[var(--muted-fg)]">
        <span aria-hidden className="mx-[3px] size-2 shrink-0 rounded-full bg-[var(--agent-tone-needs-user)]" />
        {inSession ? t('message.taskCard.questionInSession', { ns: 'messaging' }) : t('question.waiting')}
      </span>
    )
  }
  const answered = settlement.state === 'resolved' ? questionAnsweredText(settlement.optionId) : ''
  return (
    <span className="truncate text-[var(--font-caption)] text-[var(--muted-fg)]">
      {answered ? t('message.taskCard.questionAnswered', { ns: 'messaging', answer: answered }) : t('question.withdrawn')}
    </span>
  )
}

function safeAnswerJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return null }
}
