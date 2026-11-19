// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settlement, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract'
import { AgentQuestionCard } from '../../../../apps/desktop/src/components/chat/AgentQuestionCard'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <span>{content}</span> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
const request = (id: string): Settlement => ({ itemId: id, kind: 'question', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null, questions: [
  { question: '预算？', multiSelect: false, options: [{ optionId: '300', name: '300 元' }] },
  { question: '风格？', multiSelect: false, options: [{ optionId: 'casual', name: '休闲' }] },
] })
const click = async (selector: string) => act(async () => { (harness.container.querySelector(selector) as HTMLButtonElement).click() })

describe('compact question card', () => {
  it('deferring does not answer; all questions need an explicit final submit', async () => {
    const respond = vi.fn(async () => ({ accepted: true } as SessionpageSessionRespondResult))
    await renderWithAppProviders(harness, <AgentQuestionCard scope="owner:session" settlement={request('explicit-submit')} respond={respond} />)
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(true)
    await click('.agent-question-card__later')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-receipt button')
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    expect(respond).not.toHaveBeenCalled()
    expect(harness.container.textContent).toContain('提交前核对')
    expect(harness.container.textContent).toContain('300 元')
    expect(harness.container.textContent).toContain('休闲')
    await click('.agent-question-card__submit')
    expect(respond).toHaveBeenCalledWith([{ selected: ['300'] }, { selected: ['casual'] }])
    expect(harness.container.querySelector('[data-testid="agent-question-card"], [data-testid="agent-question-receipt"]')).toBeNull()
  })

  it('does not claim success after a delivery failure and prevents repeated in-flight submission', async () => {
    let reject!: (error: Error) => void
    const respond = vi.fn(() => new Promise<SessionpageSessionRespondResult>((_resolve, fail) => { reject = fail }))
    await renderWithAppProviders(harness, <AgentQuestionCard scope="owner:session" settlement={request('delivery-failed')} respond={respond} />)
    await click('.agent-question-card__option'); await click('.agent-question-card__submit')
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    // Do not await the unresolved delivery, only the event dispatch.
    act(() => { (harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).click() })
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(true)
    expect(respond).toHaveBeenCalledTimes(1)
    await act(async () => { reject(new Error('disconnected')) })
    expect(harness.container.querySelector('[data-testid="agent-question-receipt"]')).toBeNull()
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a multi-select and a direct answer through review edits without sending early', async () => {
    const respond = vi.fn()
    const settlement = request('review-edits')
    settlement.questions = [
      { question: '覆盖范围？', multiSelect: true, options: [{ optionId: 'group', name: '群聊' }, { optionId: 'topic', name: '话题' }] },
      { question: '补充说明？', multiSelect: false, options: [{ optionId: 'none', name: '无' }] },
    ]
    await renderWithAppProviders(harness, <AgentQuestionCard scope="review-edits" settlement={settlement} respond={respond} />)
    await click('.agent-question-card__option:nth-child(1)')
    await click('.agent-question-card__option:nth-child(2)')
    expect(harness.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2)
    await click('.agent-question-card__option:last-child')
    expect(harness.container.querySelector('textarea')).not.toBeNull()
    await click('.agent-question-card__option:last-child')
    expect(harness.container.querySelector('textarea')).toBeNull()
    expect(harness.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2)
    expect(harness.container.querySelector('.agent-question-card__number, .agent-question-card__mark')).toBeNull()
    await click('.agent-question-card__submit')
    await click('.agent-question-card__option:last-child')
    const input = harness.container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '手机不要横向滚动')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('.agent-question-card__submit')
    expect(harness.container.textContent).toContain('群聊、话题')
    expect(harness.container.textContent).toContain('手机不要横向滚动')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-card__answer-head button')
    expect(harness.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2)
  })

  it('resets the draft when the host changes the questions under the same item id', async () => {
    const settlement = request('changed-generation')
    const respond = vi.fn()
    await renderWithAppProviders(harness, <AgentQuestionCard scope="changed-generation" settlement={settlement} respond={respond} />)
    await click('.agent-question-card__option')
    const changed = { ...settlement, questions: [{ ...settlement.questions![0]!, question: '新的问题？' }] }
    await renderWithAppProviders(harness, <AgentQuestionCard scope="changed-generation" settlement={changed} respond={respond} />)
    expect(harness.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    expect((harness.container.querySelector('.agent-question-card__submit') as HTMLButtonElement).disabled).toBe(true)
  })
})
