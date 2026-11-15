// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TopicTaskEntry } from '../../../../apps/desktop/src/components/chat/TopicTaskEntry'
import { setComposerVerb, takeComposerCarry } from '../../../../apps/desktop/src/lib/composerVerbBridge'
import { composerDrafts } from '../../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { taskDispatchDraftKey } from '../../../../apps/desktop/src/session/renderer/features/sessions/task-dispatch-composer'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { chat, clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import { plainTextDoc } from '../../../../packages/session-ui/src/react/components/prompt-editor/serialize'
import { useMessages } from '@gugu/session-ui/react/components'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

// The task host UI is a boundary: keep the real entry, menu, editor, draft bridge and cancellation.
vi.mock('@renderer/features/sessions/new-session-page', () => ({
  NewSessionComposer: ({ taskChatId, birthChatId, verb, onSessionCreated }: {
    taskChatId?: string; birthChatId?: string; verb?: { tag: () => React.ReactNode };
    onSessionCreated?: (result: { projectId: string; sessionId: string }) => void
  }) => {
    // The real creation composer consumes this context too; a sibling chat provider is insufficient.
    const { locale } = useMessages()
    return <div data-testid="created-task-config" data-topic={taskChatId} data-group={birthChatId} data-locale={locale}>
    {verb?.tag()}
    <button onClick={() => onSessionCreated?.({ projectId: 'project', sessionId: 'created' })}>Complete fixture creation</button>
    </div>
  },
}))
vi.mock('@renderer/features/sessions/composer-tray', () => ({ ComposerTray: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@renderer/features/remote-hosts/use-new-session-machine', () => ({ useNewSessionMachine: () => ({ remote: null, machineContext: null, devicePicker: null }) }))
vi.mock('@renderer/features/sessions/use-machine-create-target', () => ({ machineComposerProps: () => ({}) }))
vi.mock('@renderer/features/library/library-host', () => ({ machineLibraryHost: () => ({}) }))
vi.mock('@renderer/features/sessions/implicit-session-home-project', () => ({ ensureImplicitSessionHomeProjectId: () => new Promise(() => {}) }))

let harness: ReturnType<typeof createReactHarness>
const input = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-composer-aside"]')!
const config = () => harness.container.querySelector<HTMLElement>('[data-testid="created-task-config"]')
beforeEach(() => { harness = createReactHarness() })
afterEach(async () => {
  harness.cleanup()
  setComposerVerb('topic', null); takeComposerCarry('topic')
  composerDrafts.discard(taskDispatchDraftKey('topic'))
  await i18n.changeLanguage('zh-CN')
})
async function renderTopic(source = true) {
  await renderWithAppProviders(harness,
    <TopicTaskEntry chatId="topic" sourceChatId="group" topicName="Current topic" surface="aside" isGroupChat onSend={async () => {}} />,
    { chat: { chats: source ? [chat({ id: 'group', kind: 'group', name: 'Source group' })] : [] } })
}
async function openTask() {
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-composer-attach-menu"]')!)
  const task = document.querySelector<HTMLElement>('[data-testid="chat-composer-attach-topic-new-task"]')!
  expect(task).not.toBeNull()
  await clickElement(task)
}

it('carries the live topic document into a task with its source group, and cancellation restores the edited task draft', async () => {
  await renderTopic()
  await act(async () => { writeComposer(input(), 'older React snapshot') })
  const editor = (input() as HTMLElement & { editor: { commands: { setContent: (doc: ReturnType<typeof plainTextDoc>, options: { emitUpdate: boolean }) => void } } }).editor
  await act(async () => { editor.commands.setContent(plainTextDoc('current unflushed document'), { emitUpdate: false }) })
  await openTask()
  expect(config()?.dataset).toMatchObject({ topic: 'topic', group: 'group' })
  expect(composerDrafts.get(taskDispatchDraftKey('topic'))).toBe('current unflushed document')
  expect(readComposer(input())).toBe('')
  await act(async () => { composerDrafts.set(taskDispatchDraftKey('topic'), 'edited task words') })
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="task-dispatch-cancel"]')!)
  expect(config()).toBeNull()
  expect(readComposer(input())).toBe('edited task words')
})

it('offers the short English action and returns to the same topic composer after creation', async () => {
  await i18n.changeLanguage('en-US')
  await renderTopic()
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-composer-attach-menu"]')!)
  const task = document.querySelector<HTMLElement>('[data-testid="chat-composer-attach-topic-new-task"]')!
  expect(task.textContent).toBe('New task')
  await clickElement(task)
  expect(config()?.dataset.topic).toBe('topic')
  await clickElement([...harness.container.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === 'Complete fixture creation')!)
  expect(config()).toBeNull()
  expect(input().closest('[hidden]')).toBeNull()
})

it('does not offer task creation without a known source group', async () => {
  await renderTopic(false)
  expect(harness.container.querySelector('[data-testid="chat-composer-attach-menu"]')).toBeNull()
  expect(config()).toBeNull()
})

it('opens mobile creation from the topic attachment panel with a fixed source and topic', async () => {
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 412 })
  const opened = vi.fn()
  window.addEventListener(UI_EVENTS.createAgentInGroup, opened)
  try {
    await renderTopic()
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-composer-attach-menu"]')!)
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-composer-attach-topic-new-task"]')!)
    expect(opened).toHaveBeenCalledOnce()
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ chatId: 'group', topic: { chatId: 'topic', name: 'Current topic' } })
    expect(config()).toBeNull()
  } finally {
    window.removeEventListener(UI_EVENTS.createAgentInGroup, opened)
    Object.defineProperty(window, 'innerWidth', width)
  }
})
