// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'
import { stubVisibleIntersection } from '../../support/visibleIntersection'
import type { LifeView } from '../../../apps/desktop/src/session/shared/core/sessions/session-life'
const sendNotices = vi.hoisted(() => new Map<string | number, string>())
vi.mock('sonner', () => {
  let sequence = 0
  const show = (title: string, options?: { id?: string }) => { const id = options?.id ?? ++sequence; sendNotices.set(id, title); return id }
  return { toast: Object.assign(show, { error: show, info: show, success: show, warning: show, dismiss: (id: string | number) => sendNotices.delete(id) }) }
})
vi.mock('../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
vi.mock('../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <span>{content}</span> }))
const lifeRead = vi.hoisted(() => vi.fn())
const hostActions = vi.hoisted(() => ({
  retry: vi.fn<(_sessionId: string, _inputId: string) => Promise<void>>(),
  discard: vi.fn<(_sessionId: string, _inputId: string) => Promise<void>>(),
  listeners: new Set<(view: LifeView) => void>(),
}))
const transcriptCommands = vi.hoisted(() => vi.fn())
const transcriptView = vi.hoisted(() => ({ setScrollMode: vi.fn(), openItem: vi.fn(() => false) }))
const openImageViewer = vi.hoisted(() => vi.fn())
vi.mock('../../../apps/desktop/src/lib/imageViewer', () => ({ openImageViewer }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(), onLinkChange: vi.fn(() => () => {}),
  onMachineEvent: vi.fn((_device: string, channel: { name: string }, listener: (view: LifeView) => void) => {
    if (channel.name === 'session:life-view') hostActions.listeners.add(listener)
    return () => { hostActions.listeners.delete(listener) }
  }),
  machineRpc: () => ({ sessions: { lifeView: lifeRead, lifeRetryUnknown: hostActions.retry, lifeDiscard: hostActions.discard } }),
}))
vi.mock('../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { composerContent: import('react').ReactNode; commands?: unknown; pendingMessages?: unknown; onReady?: (view: unknown) => void }) => {
  transcriptCommands(props.commands, props.pendingMessages)
  const [ready, setReady] = useState(false)
  const onReady = props.onReady
  useEffect(() => { const timer = setTimeout(() => { onReady?.(transcriptView); setReady(true) }, 20); return () => clearTimeout(timer) }, [onReady])
  return ready ? createElement('div', {}, props.composerContent) : null
} }))

import { SessionConversation } from '../../../apps/desktop/src/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { state, changed, EMPTY } from '../../../apps/desktop/src/lib/sessionInputOutboxBridge'
import type { SessionInputOutbox } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import { SessionInputQueue } from '../../../apps/desktop/src/components/chat/SessionInputQueue'
import * as attachmentEndpoint from '../../../apps/desktop/src/lib/attachmentsEndpoint'
import * as sessionPublication from '../../../apps/desktop/src/lib/sessionPublication'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
let harness: ReturnType<typeof createReactHarness>
const oldScroll = Element.prototype.scrollTo
const oldWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
beforeEach(() => { sendNotices.clear(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); harness = createReactHarness(); stubVisibleIntersection(); Element.prototype.scrollTo = () => undefined })
afterEach(() => { Object.defineProperty(window, 'innerWidth', oldWidth); harness.cleanup(); vi.restoreAllMocks(); Element.prototype.scrollTo = oldScroll; vi.unstubAllGlobals();
  Object.assign(state(), { accountId: null, queue: null, rows: EMPTY, valid: () => false }); changed(); lifeRead.mockReset(); transcriptView.setScrollMode.mockClear()
  hostActions.retry.mockReset(); hostActions.discard.mockReset(); hostActions.listeners.clear()
})
it('puts each App draft in the real task composer once, preserving human edits and sending nothing', async () => {
  const onSend = vi.fn(), applied = vi.fn()
  const timeline = emptyAgentWatchTimeline()
  const render = (draft?: { text: string }) => renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline, deviceId: 'desktop', sessionId: 'task', agentName: 'Test agent', sessionRuntime: 'acp', draft, onDraftApplied: applied,
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  const first = { text: 'Review the deck' }
  await render(first)
  await waitForCondition(() => !!field() && readComposer(field()) === first.text, 'the App draft is in the composer')
  await render(first)
  expect(readComposer(field())).toBe(first.text)
  await act(async () => writeComposer(field(), 'My existing notes'))
  await render({ text: 'Check slide 3' })
  await vi.waitFor(() => expect(readComposer(field())).toBe('My existing notes\nCheck slide 3'))
  expect(applied).toHaveBeenCalledTimes(2)
  expect(onSend).not.toHaveBeenCalled()
  expect(lifeRead).not.toHaveBeenCalled()
})

it('keeps the running task Send action until its local outbox commit resolves', async () => {
  // A successful local commit belongs to the active sender account.
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  let commit!: () => void
  const onSend = vi.fn(() => new Promise<void>(resolve => { commit = resolve }))
  const onStop = vi.fn()
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'send-state-1451', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: true,
    onStop, stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  const send = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')
  const stop = () => harness.container.querySelector('[data-composer-action="stop"]')
  await waitForCondition(() => !!field(), 'task composer ready')
  expect(stop()).not.toBeNull()
  await act(async () => writeComposer(field(), 'one queued intent'))
  expect(send()?.disabled).toBe(false)
  await act(async () => { send()!.click(); send()!.click(); send()!.click() })
  await waitForCondition(() => onSend.mock.calls.length === 1, 'task reaches local outbox')
  expect(transcriptView.setScrollMode).toHaveBeenCalledExactlyOnceWith({ kind: 'tail' })
  // The reader can leave while this commit is pending; success cannot restore following.
  transcriptView.setScrollMode.mockClear()
  // The draft retains custody until onSend confirms the durable outbox commit.
  expect(readComposer(field())).toBe('one queued intent')
  expect(send()?.disabled).toBe(true)
  expect(stop()).toBeNull()
  expect(onStop).not.toHaveBeenCalled()
  await act(async () => commit())
  expect(readComposer(field())).toBe('')
  expect(transcriptView.setScrollMode).not.toHaveBeenCalled()
  expect(stop()).not.toBeNull()
  expect(onStop).not.toHaveBeenCalled()
})


it('does not republish transcript commands while typing or clearing a phone draft', async () => {
  const onSend = vi.fn(async () => {})
  const props = {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'stable-commands-1451', agentName: 'Test agent', sessionRuntime: 'acp' as const,
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }
  await renderWithAppProviders(harness, createNode(SessionConversation, props))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  await waitForCondition(() => !!field(), 'phone composer ready')
  const original = transcriptCommands.mock.lastCall![0]
  const originalPending = transcriptCommands.mock.lastCall![1]
  transcriptCommands.mockClear()
  await act(async () => writeComposer(field(), 'typing a message'))
  await act(async () => writeComposer(field(), 'typing a longer message'))
  await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(transcriptCommands.mock.calls.length).toBeGreaterThan(0)
  for (const [commands, pending] of transcriptCommands.mock.calls) { expect(commands).toBe(original); expect(pending).toBe(originalPending) }
  const replacementStop = vi.fn()
  await renderWithAppProviders(harness, createNode(SessionConversation, { ...props, onStop: replacementStop }))
  const updated = transcriptCommands.mock.lastCall![0] as { onStop: () => void }
  updated.onStop()
  expect(replacementStop).toHaveBeenCalledTimes(1)
})

it('opens an inline user image in the image viewer outside a native-record task', async () => {
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'inline-image', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend: vi.fn(), pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  await waitForCondition(() => !!transcriptCommands.mock.lastCall, 'transcript commands published')
  const commands = transcriptCommands.mock.lastCall![0] as import('@gugu/session-chat-ui').ChatCommands
  commands.onViewAttachment!({ attachment: { id: 'inline', name: 'shot.png', kind: 'image', dataUrl: 'data:image/png;base64,AA==' }, itemId: 'u1', source: 'user-message' })
  await vi.waitFor(() => expect(openImageViewer).toHaveBeenCalledExactlyOnceWith([{ url: 'data:image/png;base64,AA==', alt: 'shot.png', file: { name: 'shot.png' }, thumb: undefined }], 0))
})

it('shows an online host refusal through the existing input queue failure status and retry action', async () => {
  const failure = { code: 'send-failed' as const, message: 'Provider login expired' }
  const input = { id: 'failed-local', accountId: 'owner', deviceId: 'desktop', sessionId: 'failure-1451', text: 'queued intent', createdAt: 1, queued: true, failure }
  const retryInput = vi.fn(async () => {})
  Object.assign(state(), { accountId: 'owner', queue: Promise.resolve({ retry: retryInput } as unknown as SessionInputOutbox), rows: [input], valid: () => true })
  lifeRead.mockResolvedValue({ sessionId: 'failure-1451', version: 1, kind: 'ready', pending: { count: 0, items: [] } })
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'failure-1451', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend: vi.fn(), pendingSends: [], sending: false, agentWorking: true,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
    footerNotice: createNode(SessionInputQueue, { sessionId: 'failure-1451', waitingForConnection: false }),
  }))
  await waitForCondition(() => !!harness.container.querySelector('[data-testid="prompt-editor"]'), 'phone composer ready')
  const status = harness.container.querySelector('[data-native-input-id="failed-local"] [data-send-state="failed"]')
  expect(status?.textContent).toContain(failure.message)
  expect(harness.container.querySelector('[data-queued-prompt-id="failed-local"]')).toBeNull()
  expect(state().rows).toEqual([input])
  const retry = [...status!.querySelectorAll('button')].find(button => button.textContent === translateSessionMessage('transcript.retrySend'))!
  await act(async () => retry.click())
  expect(retryInput).toHaveBeenCalledExactlyOnceWith(input.id)
})

it('phone task submission retries replace one failure and success leaves another task failure intact', async () => {
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  const sendA = vi.fn().mockRejectedValue(new Error('storage refused')), sendB = vi.fn().mockRejectedValue(new Error('storage refused'))
  const props = { timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', agentName: 'Test agent', sessionRuntime: 'acp' as const,
    respondingItemId: null, onRespond: vi.fn(), pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined }
  await renderWithAppProviders(harness, <><SessionConversation {...props} sessionId="notice-task-a" onSend={sendA} />
    <SessionConversation {...props} sessionId="notice-task-b" onSend={sendB} /></>)
  const fields = () => harness.container.querySelectorAll<HTMLElement>('[data-testid="prompt-editor"]')
  const send = (index: number) => act(async () => harness.container.querySelectorAll<HTMLButtonElement>('button[aria-label="发送消息"]')[index].click())
  await waitForCondition(() => fields().length === 2, 'both real phone composers ready')
  await act(async () => { writeComposer(fields()[0], 'same words'); writeComposer(fields()[1], 'same words') })
  await send(0); await send(1)
  expect(sendNotices.size).toBe(2)
  await send(0); expect(sendNotices.size).toBe(2)
  sendA.mockResolvedValue(undefined)
  await send(0)
  expect(sendNotices.size).toBe(1)
  expect(readComposer(fields()[0])).toBe('')
  expect(readComposer(fields()[1])).toBe('same words')
  await act(async () => writeComposer(fields()[1], 'a new message'))
  sendB.mockResolvedValue(undefined); await send(1)
  expect(sendNotices.size).toBe(1)
})

it('the phone pre-send guard and the successful submission share one retained submission notice', async () => {
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  const onSend = vi.fn(async () => {}), before = vi.fn<() => void>(() => { throw new Error('not ready') })
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'notice-guard', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend, onBeforeSend: before, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  await waitForCondition(() => !!field(), 'real phone composer ready')
  await act(async () => writeComposer(field(), 'retained words'))
  const send = () => act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
  await send(); await send()
  expect(sendNotices.size).toBe(1); expect(onSend).not.toHaveBeenCalled()
  before.mockImplementation(() => {})
  await send()
  expect(onSend).toHaveBeenCalledTimes(1); expect(sendNotices.size).toBe(0)
})

it('adding a file creates a new submission without settling the earlier text-only failure', async () => {
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  vi.spyOn(sessionPublication, 'getRendererSession').mockReturnValue({ user: { id: 'owner' } } as NonNullable<ReturnType<typeof sessionPublication.getRendererSession>>)
  vi.spyOn(chatService, 'getOrCreateDM').mockResolvedValue('agent-dm')
  vi.spyOn(attachmentEndpoint, 'prepareTaskAttachment').mockResolvedValue(null)
  vi.spyOn(attachmentEndpoint, 'placeTaskAttachment').mockImplementation(async file => ({ itemId: 'uploaded', version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size }))
  const onSend = vi.fn<(text: string, files?: import('@gugu/session-core/session-record/contract').TurnFileRef[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error('first refused')).mockResolvedValue(undefined)
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId: 'attachment-intent', agentUserId: 'agent', agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend, pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  const send = () => act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.click())
  await waitForCondition(() => !!field(), 'phone composer ready')
  await act(async () => writeComposer(field(), 'unchanged words'))
  await send(); expect(sendNotices.size).toBe(1)
  const picker = harness.container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['new attachment'], 'new.txt', { type: 'text/plain' })] })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await send()
  expect(onSend.mock.calls[1][1]).toEqual([expect.objectContaining({ name: 'new.txt' })])
  expect(sendNotices.size).toBe(1)
})

it('settles only the discarded host input notice when the real life event removes its unknown row', async () => {
  Object.assign(state(), { accountId: 'owner', valid: () => true })
  const sessionId = 'host-discard-notice'
  const view = (version: number, ids: string[]): LifeView => ({ sessionId, version, kind: 'ready', stage: null,
    hold: null, failure: null, lastExit: null, nativeSession: null, pending: { count: 0,
      items: ids.map((messageId, seq) => ({ seq, messageId, preview: messageId, text: messageId,
        kind: 'session-direct', state: 'unknown', discardable: true, resendable: true, failure: null })) } })
  await renderWithAppProviders(harness, createNode(SessionConversation, {
    timeline: emptyAgentWatchTimeline(), deviceId: 'desktop', sessionId, agentName: 'Test agent', sessionRuntime: 'acp',
    respondingItemId: null, onRespond: vi.fn(), onSend: vi.fn(), pendingSends: [], sending: false, agentWorking: false,
    onStop: vi.fn(), stopping: false, onLoadOlder: async () => undefined,
  }))
  await waitForCondition(() => hostActions.listeners.size > 0, 'real host life subscription ready')
  await act(async () => { for (const listener of hostActions.listeners) listener(view(1, ['host-a', 'host-b'])) })
  const pending = () => (transcriptCommands.mock.lastCall![1] as { id: string }[]).map(input => input.id)
  await waitForCondition(() => pending().length === 2, 'both actual host rows projected')
  const commands = () => transcriptCommands.mock.lastCall![0] as import('@gugu/session-chat-ui').ChatCommands
  hostActions.retry.mockRejectedValue(new Error('host retry refused'))
  await act(async () => { commands().onRetrySend!('host-a'); commands().onRetrySend!('host-b') })
  await vi.waitFor(() => expect(sendNotices.size).toBe(2))
  hostActions.discard.mockRejectedValueOnce(new Error('host discard refused'))
  await act(async () => commands().onDiscardSend!('host-a'))
  expect(sendNotices.size).toBe(2); expect(pending()).toEqual(['host-a', 'host-b'])
  hostActions.discard.mockImplementation(async (_sessionId, id) => {
    for (const listener of hostActions.listeners) listener(view(2, ['host-b']))
    expect(id).toBe('host-a')
  })
  await act(async () => commands().onDiscardSend!('host-a'))
  await vi.waitFor(() => expect(pending()).toEqual(['host-b']))
  expect(sendNotices.size).toBe(1)
  expect(hostActions.discard.mock.calls).toEqual([[sessionId, 'host-a'], [sessionId, 'host-a']])
})
