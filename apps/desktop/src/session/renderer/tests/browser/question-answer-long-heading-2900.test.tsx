import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { QuestionAnswer, SettlementQuestion } from '@gugu/session-core/session-record/contract'
import { AgentQuestionAnswers } from '@/components/chat/AgentQuestionAnswers'
import { i18n } from '@/i18n'
import '@/i18n/registerAssistantCatalog'
import '@/styles/tokens.css'
import '@/components/chat/agent-question-card.css'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'

// Component layout regression only: no timeline, host, database, or model connection.
const questions: readonly SettlementQuestion[] = [
  { header: 'W'.repeat(120), question: 'Choose a destination.', multiSelect: false,
    options: [{ optionId: 'chat', name: 'Current chat' }] },
  { question: `https://example.invalid/${'W'.repeat(180)}`, multiSelect: false,
    options: [{ optionId: 'session', name: 'Conversation' }] },
  { header: 'Coverage', question: 'Which conversations?', multiSelect: true,
    options: [{ optionId: 'group', name: 'Group chat' }, { optionId: 'topic', name: 'Topic' }] },
]
const answers: readonly QuestionAnswer[] = [
  { selected: ['chat'] },
  { selected: ['session'] },
  { selected: ['group', 'topic'], other: `${'LongAnswer'.repeat(60)}\n${'完整保留多行补充回答。'.repeat(20)}` },
]

let harness: ReturnType<typeof createReactHarness>
let previousTheme: string | null
let previousLanguage: string
beforeEach(() => {
  harness = createReactHarness()
  previousTheme = document.documentElement.getAttribute('data-theme')
  previousLanguage = i18n.language
})
afterEach(async () => {
  harness.cleanup()
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', previousTheme)
  await i18n.changeLanguage(previousLanguage)
})

for (const surface of [{ name: 'desktop', viewport: 1080, card: 384 }, { name: 'phone-width web', viewport: 390, card: 358 }]) {
  for (const language of ['zh-CN', 'en-US']) {
    for (const theme of ['light', 'dark']) {
      for (const phase of ['review', 'receipt']) {
        it(`${surface.name}/${language}/${theme}/${phase}: wraps complete question headings and preserves long answers`, async () => {
          await page.viewport(surface.viewport, 900)
          document.documentElement.dataset.theme = theme
          await i18n.changeLanguage(language)
          harness.container.style.width = `${surface.card}px`
          const onEdit = vi.fn()
          const content = <AgentQuestionAnswers questions={questions} answers={answers} onEdit={phase === 'review' ? onEdit : undefined} />
          // Use the production CSS scopes for the shared review and historical receipt component.
          await harness.render(<div className="question-message-card">
            {phase === 'review'
              ? <section className="agent-question-card" data-embedded="true" data-mobile={surface.viewport < 720 || undefined}>{content}</section>
              : <div className="question-message-card__receipt">{content}</div>}
          </div>)
          await document.fonts.ready

          const card = harness.container.querySelector<HTMLElement>('.question-message-card')!
          const heads = [...card.querySelectorAll<HTMLElement>('.agent-question-card__answer-head')]
          expect(heads).toHaveLength(questions.length)
          expect(card.getBoundingClientRect().width).toBe(surface.card)
          expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1)
          for (const [index, head] of heads.entries()) {
            const title = head.querySelector<HTMLElement>('span')!
            expect(title.textContent).toBe(questions[index].header || questions[index].question)
            expect(head.scrollWidth).toBeLessThanOrEqual(head.clientWidth + 1)
            const range = document.createRange()
            range.selectNodeContents(title)
            const lines = [...range.getClientRects()]
            if (index < 2) expect(lines.length).toBeGreaterThan(1)
            for (const line of lines) expect(line.right).toBeLessThanOrEqual(head.getBoundingClientRect().right + 1)
            const button = head.querySelector('button')
            if (button) expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(card.getBoundingClientRect().right)
          }
          const values = [...card.querySelectorAll<HTMLElement>('.agent-question-card__answer p')]
          expect(values[0].textContent).toBe('Current chat')
          expect(values[1].textContent).toBe('Conversation')
          expect(values[2].textContent).toBe(['Group chat', 'Topic', answers[2].other].join(i18n.t('question.answerSeparator', { ns: 'assistant' })))
          for (const value of values) expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth + 1)
          if (phase === 'review') {
            await page.getByRole('button', { name: i18n.t('question.edit', { ns: 'assistant' }), exact: true }).nth(1).click()
            expect(onEdit).toHaveBeenCalledExactlyOnceWith(1)
          } else {
            expect(card.querySelectorAll('button')).toHaveLength(0)
          }
        })
      }
    }
  }
}
