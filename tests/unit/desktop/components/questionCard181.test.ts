// @vitest-environment jsdom
// gugu-dev#181 ⑨ 问题卡在群里:问我的,选项能点(点了 = 引用卡回一句选项名)、一行状态读会话结算 ——
// 待你回答 / 已回答：X(选项变灰)/ 这次提问已结束;不是问我的(同事),只有问题和灰着的选项,不去读谁的会话。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { QuestionCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const send = vi.fn(async () => 'reply-1')
const respond = vi.fn(async (answer: Record<string, unknown>) => {
  if (!settlement) throw new Error('Missing host settlement fixture')
  return { accepted: true, settlement: { ...settlement, state: 'resolved', optionId: JSON.stringify(answer.answers) } }
})
let viewer = 'owner-1'
let link = 'ok'
let settlement: Record<string, unknown> | null = null
const reads: Array<{ enabled: boolean; deviceId: string | null }> = []

vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'claude' }))
vi.mock('../../../../apps/desktop/src/lib/avatarIdentity', async original => ({ ...await original<object>(), useAvatarIdentity: () => ({ display_name: 'Alice' }) }))
vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => createNode('span', {}, content) }))
vi.mock('../../../../apps/desktop/src/store/auth', async (original) => ({ ...await original<object>(), useAuth: () => ({ user: { id: viewer } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', async (original) => ({
  ...await original<object>(), useDevicesStore: () => ({ devices: viewer === 'owner-1' ? [{ device_id: 'device-1', is_current_device: true }] : [] }),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', async (original) => ({ ...await original<object>(), useChatStore: () => ({ sendMessageToChat: send }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({
  useTimelineSession: (_client: unknown, _by: string, deviceId: string | null, _session: string | null, enabled: boolean) => {
    reads.push({ enabled, deviceId })
    return { timeline: { settlements: enabled && settlement ? { 'agent-question:q1': settlement } : {} }, respond, link }
  },
}))

const { QuestionCardView } = await import('../../../../apps/desktop/src/components/chat/QuestionCardView')

const CARD: QuestionCard = {
  v: 1, type: 'question', text: '要把初始化提前到登录之前吗？', options: ['提前', '先不动'], ownerUserId: 'owner-1',
  questionId: 'agent-question:q1', sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'Mac',
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); viewer = 'owner-1'; link = 'ok'; settlement = null; reads.length = 0; send.mockClear(); respond.mockClear() })
afterEach(() => { harness.cleanup() })

const render = (card: QuestionCard = CARD) => renderWithAppProviders(harness, createNode(QuestionCardView, { card, chatId: 'group-1', messageId: 'card-msg', agentUserId: 'agent-7', time: '10:21' }))
const options = () => [...harness.container.querySelectorAll('button')].filter((button) => CARD.options.includes(button.textContent ?? ''))

describe('question card in a group (gugu-dev#181 ⑨)', () => {
  it('asked of me and waiting: a pick replies to the card with the choice', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render()
    expect(harness.container.textContent).toContain('要把初始化提前到登录之前吗？')
    expect(harness.container.textContent).toContain('待你回答')
    expect(options().every((button) => !button.disabled)).toBe(true)
    await act(async () => { options()[0]!.click() })
    expect(send).toHaveBeenCalledWith('group-1', '提前', { replyToMessageId: 'card-msg' })
  })

  it('answered: says what, and the choices go grey', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'resolved', optionId: JSON.stringify([{ selected: ['先不动'] }]) }
    await render()
    expect(harness.container.textContent).toContain('已回答：先不动')
    expect(options().every((button) => button.disabled)).toBe(true)
  })

  it('withdrawn: the question has closed', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'cancelled', optionId: null }
    await render()
    expect(harness.container.textContent).toContain('这次提问已结束')
  })

  it('a colleague sees the question and its choices, greyed, and nobody\'s session is read', async () => {
    viewer = 'colleague-1'
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render()
    expect(options().every((button) => button.disabled)).toBe(true)
    expect(harness.container.textContent).not.toContain('待你回答')
    expect(reads.every((read) => !read.enabled)).toBe(true)
  })

  it('several parts: no choices on the card, it is answered in the task', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'pending', optionId: null }
    await render({ ...CARD, options: [] })
    expect(harness.container.textContent).toContain('到任务里回答')
    expect(harness.container.querySelector('[data-testid="composer-card"]')!.tagName).toBe('BUTTON')
  })

  const fullQuestions = [
    { question: '选哪种？', multiSelect: false, options: [{ optionId: 'first', name: '第一种' }] },
    { question: '覆盖哪里？', multiSelect: true, options: [{ optionId: 'group', name: '群聊' }, { optionId: 'topic', name: '话题' }] },
  ]
  const click = async (selector: string) => act(async () => { (harness.container.querySelector(selector) as HTMLButtonElement).click() })

  it('uses the complete authoritative question flow inline, with one final host response', async () => {
    settlement = { itemId: 'agent-question:q1', kind: 'question', state: 'pending', optionId: null, questions: fullQuestions }
    await render({ ...CARD, options: [] })
    expect(harness.container.querySelector('[data-testid="agent-question-card"]')).not.toBeNull()
    await click('.agent-question-card__option')
    await click('.agent-question-card__submit')
    await click('.agent-question-card__option:nth-child(1)')
    await click('.agent-question-card__option:nth-child(2)')
    await click('.agent-question-card__submit')
    expect(respond).not.toHaveBeenCalled()
    await click('.agent-question-card__submit')
    expect(respond).toHaveBeenCalledWith({ itemId: CARD.questionId, kind: 'question', answers: [{ selected: ['first'] }, { selected: ['group', 'topic'] }] })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps every confirmed answer in the historical card without active controls', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'resolved', questions: fullQuestions, optionId: JSON.stringify([{ selected: ['first'] }, { selected: ['group', 'topic'] }]) }
    await render({ ...CARD, options: [] })
    expect(harness.container.textContent).toContain('第一种')
    expect(harness.container.textContent).toContain('群聊、话题')
    expect(harness.container.querySelector('[data-testid="agent-question-receipt"]')).not.toBeNull()
    expect(harness.container.querySelector('.agent-question-card__submit')).toBeNull()
  })

  it('does not expose another owner’s full questions or answer controls', async () => {
    viewer = 'colleague-1'
    settlement = { itemId: 'agent-question:q1', state: 'pending', questions: fullQuestions, optionId: null }
    await render({ ...CARD, options: [] })
    expect(harness.container.textContent).not.toContain('选哪种？')
    expect(harness.container.querySelector('[data-testid="agent-question-card"]')).toBeNull()
    expect(reads.every(read => !read.enabled)).toBe(true)
    expect(respond).not.toHaveBeenCalled()
  })

  it.each(['colleague-1', 'owner-1'])('shows the complete public snapshot read-only for %s without a private timeline', async who => {
    viewer = who
    const questions = [
      { ...fullQuestions[0], header: '展示方式', options: [{ optionId: 'first', name: '第一种', description: '留在当前聊天里回答' }] },
      fullQuestions[1],
      { question: '补充要求？', multiSelect: false, options: [] },
    ]
    await render({ ...CARD, options: [], questions })
    for (const text of ['选哪种？', '覆盖哪里？', '补充要求？', '展示方式', '留在当前聊天里回答', '选一项', '可多选']) expect(harness.container.textContent).toContain(text)
    expect(harness.container.textContent).toContain('需要 Alice 确认')
    expect(harness.container.textContent).toContain('待 Alice 回答')
    expect(harness.container.querySelectorAll('.agent-question-card__option:last-child')).toHaveLength(3)
    expect(harness.container.querySelector('button, input, textarea, [role="button"], [role="radio"], [role="checkbox"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="question-card-readonly"]')).not.toBeNull()
    if (who === 'colleague-1') expect(reads.every(read => !read.enabled)).toBe(true)
    expect(respond).not.toHaveBeenCalled()
  })

  it('uses the authoritative questions rather than the public snapshot for the owner, and displays skipped receipts', async () => {
    settlement = { itemId: 'agent-question:q1', state: 'resolved', questions: fullQuestions, optionId: JSON.stringify([{ selected: [], skipped: true }, { selected: ['group'] }]) }
    await render({ ...CARD, questions: [{ question: 'Old wording', multiSelect: false, options: [] }] })
    expect(harness.container.textContent).toContain('已跳过')
    expect(harness.container.textContent).toContain('群聊')
    expect(harness.container.textContent).not.toContain('Old wording')
    expect(harness.container.querySelector('button')).toBeNull()
  })

  it('shows the full read-only snapshot when the owner has lost the host connection', async () => {
    link = 'offline'
    settlement = { itemId: 'agent-question:q1', kind: 'question', state: 'pending', optionId: null, questions: fullQuestions, skippable: true, canDiscuss: true }
    await render({ ...CARD, questions: fullQuestions })
    expect(harness.container.textContent).toContain('选哪种？')
    expect(harness.container.textContent).toContain('覆盖哪里？')
    expect(harness.container.querySelector('button, textarea')).toBeNull()
    expect(harness.container.querySelector('[data-testid="question-card-readonly"]')).not.toBeNull()
  })

  it('renders a confirmed discussion receipt without answers, unreadable warnings or controls', async () => {
    settlement = { itemId: 'agent-question:q1', kind: 'question', state: 'resolved', optionId: 'discuss', questions: fullQuestions }
    await render({ ...CARD, questions: fullQuestions })
    expect(harness.container.textContent).toContain('先聊聊')
    expect(harness.container.textContent).not.toContain('回答详情暂时无法读取')
    expect(harness.container.querySelector('button, textarea, .agent-question-card__answers')).toBeNull()
  })

  it.each(['colleague-1', 'owner-1'])('shows the same published answers to %s without reading the host or creating another message', async who => {
    viewer = who
    settlement = { itemId: CARD.questionId, state: 'pending', questions: fullQuestions }
    await render({ ...CARD, questions: fullQuestions, settled: { state: 'answered', at: 'now',
      answers: [{ selected: [], skipped: true }, { selected: ['group', 'topic'] }] } })
    for (const text of ['已回答', '已跳过', '群聊、话题']) expect(harness.container.textContent).toContain(text)
    expect(harness.container.querySelectorAll('[data-testid="composer-card"]')).toHaveLength(1)
    expect(harness.container.querySelector('button, input, textarea, [data-testid="question-card-readonly"]')).toBeNull()
    expect(reads.every(read => !read.enabled)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it.each(['withdrawn', 'discuss'] as const)('shows the public %s state without answer controls or a host connection', async state => {
    viewer = 'colleague-1'
    await render({ ...CARD, questions: fullQuestions, settled: { state, at: 'now' } })
    expect(harness.container.textContent).toContain(state === 'discuss' ? '先聊聊' : '这次提问已结束')
    expect(harness.container.querySelector('button, input, textarea')).toBeNull()
    expect(harness.container.textContent).not.toContain('待 Alice 回答')
  })
})
