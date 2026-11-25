// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { OutboxHost as SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useOutboxHost'
import { enqueueSessionInput, releaseQueuedSessionInput, retrySessionInputs, state } from '../../../../apps/desktop/src/lib/outbox/kinds/sessionInput'
import { installOutboxCore, settle } from '../../../helpers/sessionInputOutbox'
import { SessionInputQueue } from '../../../../apps/desktop/src/components/chat/SessionInputQueue'
import { updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { messageQuoteText, readMessageQuote } from '@gugu/core/shared/ui/messageQuote'
import { SessionInputAdmissionError, sessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission'
import { TASK_ATTACHMENT_PROTOCOL } from '@gugu/session-core/session-record/contract'
import type { LifeView } from '../../../../apps/desktop/src/session/shared/core/sessions/session-life'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'

const toast = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast }))
const notices = vi.hoisted(() => ({ show: vi.fn(), dismiss: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: notices.show, dismissNotice: notices.dismiss }))
const scope = vi.hoisted(() => ({ owner: 'account-a', platform: 'electron', phones: [] as Array<{ device_id: string; is_online: boolean; capabilities: { host_kind: string; remote_protocol?: number } }>, devices: [{ device_id: 'host-a', is_online: false, capabilities: {} }], received: new Map<string, string>(), send: vi.fn(), machines: [] as (string | null)[] }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: scope.owner } }), observeRendererSession: () => () => {} }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: scope.phones }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { get kind() { return scope.platform } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', async original => ({ ...await original<object>(), rpcOn: (machine: string | null) => ({ sessionTimeline: { sessionSend: (request: unknown) => { scope.machines.push(machine); return scope.send(request) } } }) }))
vi.mock('../../../../apps/desktop/src/components/session-watch/sessionpage-rpc', () => ({ sendSessionInput: async (_device: string, request: { clientMessageId: string }) => {
  const reply = await scope.send(request)
  if (!reply.ok) throw new SessionInputAdmissionError(reply.error.message, sessionInputAdmission(reply.error), reply.error.code)
  return reply.value
} }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: async (_device: string, _channel: string, [request]: [{ conversationId: string; text: string; clientRequestId: string; files?: unknown[] }]) => {
  await scope.send(request)
  return { accepted: true }
} }))
// This computer's own session list sync is another subject; these cases read only what the outbox sends.
vi.mock('../../../../apps/desktop/src/hooks/useLocalSessionDirectory', () => ({ useLocalSessionDirectory: () => undefined }))
vi.mock('../../../../apps/desktop/src/lib/sessionSendQueueHost', () => ({ watchSessionSendQueues: () => () => {} }))
// The host also registers the App-notice kind; its cloud client is another subject.
vi.mock('../../../../apps/desktop/src/lib/outbox/kinds/assistantNotice', () => ({ assistantNoticeOutboxKind: { name: 'assistantNotice', lane: () => 'assistant', send: async () => {} } }))
vi.mock('../../../../apps/desktop/src/lib/outbox/legacy', () => ({ importLegacyWrites: async () => {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', async original => ({ ...await original<object>(), translateSessionMessage: (key: string, values?: { count: number }) => key === 'composer.attachmentHostUpdateRequired' ? 'Update the task host to send attachments' : key === 'composer.annotationHostUpdateRequired' ? 'Update the task host to send comments' : key === 'composer.attachmentsNotSent' ? `(${values!.count} attachments could not be included after the upgrade. Please send them again.)` : 'Waiting for host; sends automatically' }))
let harness: ReturnType<typeof createReactHarness>
let core: ReturnType<typeof installOutboxCore> | undefined
/** The window's one outbox for the case's account (the app's comes from the replica); OutboxHost registers the kinds. */
const signIn = (owner: string) => { core?.dispose(); scope.owner = owner; core = installOutboxCore({ accountId: owner }) }
const rows = () => state().rows
/** What used to be a flush: a host or the network came back, everything waiting goes now. */
const kick = async () => { await retrySessionInputs(); await settle() }
beforeEach(() => { toast.mockClear(); notices.show.mockClear(); notices.dismiss.mockClear(); harness = createReactHarness(); signIn('account-a') })
afterEach(() => { harness.cleanup(); core?.dispose(); core = undefined; scope.owner = 'account-a'; scope.platform = 'electron'; scope.phones = []; scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]; scope.received.clear(); scope.send.mockReset(); scope.machines = [] })

describe('native input shell lifecycle', () => {
  it('shows a native device failure once and retries the same saved input from the notice', async () => {
    const message = 'Native personal-message device is unavailable'
    scope.send.mockResolvedValue({ ok: false, error: { code: 'send_failed', message, admission: 'uncertain' } })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const input = await enqueueSessionInput({ deviceId: null, sessionId: 'personal-task', text: 'keep this input' })
    await vi.waitFor(() => expect(core!.outbox.get(input.id)?.state).toBe('waiting'))
    for (let count = 0; count < 3; count += 1) await act(kick)
    expect(notices.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      description: message, tier: 'error', action: expect.objectContaining({ onClick: expect.any(Function) }),
    }))
    await act(kick)
    expect(notices.show).toHaveBeenCalledTimes(1)
    scope.send.mockResolvedValue({ ok: true, value: { clientMessageId: input.id } })
    const notice = notices.show.mock.calls[0]![0]
    await act(async () => { notice.action.onClick(); await settle() })
    expect(core!.outbox.get(input.id)).toBeUndefined()
    expect(scope.send.mock.lastCall?.[0]).toMatchObject({ clientMessageId: input.id, text: 'keep this input' })
    expect(notices.dismiss).toHaveBeenCalledWith(notice.key)
  })

  it('publishes the durable queue before enqueue resolves', async () => {
    signIn('durable-first-frame-owner')
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      const input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'held-task', text: 'keep visible', queued: true, sendQueue: { order: 0 } })
      expect(rows()).toMatchObject([{ id: input.id, text: input.text, sendQueue: expect.any(Object) }])
      expect(core!.outbox.items()).toMatchObject([{ id: input.id, state: 'held' }])
    })
    expect(scope.send).not.toHaveBeenCalled()
  })
  it('keeps a released insertion intact when a reconnecting host no longer advertises steering', async () => {
    signIn('steer-reconnect-owner')
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    updateDeviceSessions('host-a', { cached: false, connected: true, error: null, sessions: [{ conversationId: 'steer-reconnect-task', nativeInputVersion: 2, nativeInputSteering: true } as never] })
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    let inputId!: string
    await act(async () => {
      const held = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'steer-reconnect-task', text: 'insert once', queued: true, sendQueue: { order: 0 } })
      inputId = held.id
      // Released while the session is briefly absent: nothing is sent until it is back.
      core!.setCredential(null)
      await releaseQueuedSessionInput(held.sessionId, [], held.id, true)
      updateDeviceSessions('host-a', { connected: false })
      updateDeviceSessions('host-a', { cached: false, connected: true, sessions: [{ conversationId: held.sessionId, nativeInputVersion: 2 } as never] })
      core!.setCredential(scope.owner)
      await settle()
      expect(rows()).toMatchObject([{ id: held.id, steerIfBusy: true, failure: { code: 'host-not-ready' } }])
    })
    expect(scope.send).not.toHaveBeenCalled()
    await act(async () => {
      updateDeviceSessions('host-a', { cached: false, connected: true, sessions: [{ conversationId: 'steer-reconnect-task', nativeInputVersion: 2, nativeInputSteering: true } as never] })
      await kick()
    })
    expect(scope.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clientMessageId: inputId, steerIfBusy: true }))
  })
  it.each(['electron', 'web'])('keeps a previous host without an admission decision in automatic recovery (%s)', async platform => {
    scope.platform = platform
    signIn(`legacy-refusal-${platform}`)
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION - 1 } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'legacy-task', nativeInputVersion: 2 } as never] })
    scope.send.mockResolvedValue({ ok: false, error: { code: 'session_not_found', message: 'same negative reply, no admission conclusion' } })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    let id: string | undefined
    await act(async () => {
      id = (await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'legacy-task', text: 'keep recovering' })).id
      await vi.waitFor(async () => expect(rows()[0]?.failure).toBeDefined())
    })
    await act(async () => { await kick() })
    expect(scope.send).toHaveBeenCalledTimes(2)
    expect(scope.send.mock.calls.map(([request]) => request.clientMessageId)).toEqual([id, id])
    // No admission decision: it stays in automatic recovery (waiting, then undelivered), never refused.
    expect(rows()).toMatchObject([{ id, text: 'keep recovering', failure: { code: 'send-failed' } }])
    expect(rows()[0]!.admission).toBeUndefined()
  })

  it.each([null, 'host-a'])('does not automatically resend a definitive host refusal (%s)', async deviceId => {
    signIn(`rejected-input-${deviceId ?? 'local'}`)
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'deleted-task', nativeInputVersion: 2 } as never] })
    // The admission boundary now explicitly refuses the send; a legacy negative reply has no such decision.
    scope.send.mockResolvedValue({ ok: false, error: { code: 'session_not_found', message: '这台机器上没有会话 deleted-task', admission: 'rejected' } })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    let inputId: string | undefined
    await act(async () => {
      const input = await enqueueSessionInput({ deviceId, sessionId: 'deleted-task', text: 'keep this text for me' })
      inputId = input.id
      await vi.waitFor(async () => expect(rows()[0]?.failure).toBeDefined())
    })
    expect(scope.send).toHaveBeenCalledTimes(1)
    await act(async () => { await kick() })
    expect(scope.send).toHaveBeenCalledTimes(1)
    expect(rows()).toMatchObject([{ id: inputId, text: 'keep this text for me' }])
  })

  it('leaves every transcript-owned failed input out of the tray while preserving ordinary host failures', async () => {
    const item = (seq: number, messageId: string, state: 'queued' | 'failed'): LifeView['pending']['items'][number] =>
      ({ seq, messageId, state, preview: messageId, text: messageId, kind: 'ordinary', failure: state === 'failed' ? 'host refusal' : null });
    const life: LifeView = { sessionId: 'failed-host', version: 1, kind: 'failed', stage: null, hold: 'start-failed', failure: null, lastExit: null, nativeSession: null,
      pending: { count: 2, items: [item(1, 'first', 'queued'), item(2, 'second', 'queued'), item(3, 'refused', 'failed')] } };
    await harness.render(<SessionInputQueue sessionId="failed-host" waitingForConnection={false} life={life} inTranscript={['first', 'second']} />)
    expect(harness.container.querySelector('[data-native-input-id="first"]')).toBeNull()
    expect(harness.container.querySelector('[data-native-input-id="second"]')).toBeNull()
    expect(harness.container.querySelector('[data-native-input-id="refused"]')).not.toBeNull()
  })
  it('draws an input its host never answered as not sent (red) with a retry, still in automatic recovery', async () => {
    Object.assign(state(), { accountId: scope.owner, valid: () => true, rows: [{ id: 'unanswered', accountId: scope.owner, deviceId: 'host-a', sessionId: 'red-task',
      text: 'still mine', createdAt: 1, undelivered: true, failure: { code: 'host-offline' } }] })
    await harness.render(<SessionInputQueue sessionId="red-task" waitingForConnection />)
    const status = harness.container.querySelector('[data-native-input-id="unanswered"] [data-send-state="undelivered"][role="alert"]')
    expect(status).not.toBeNull()
    expect(status!.querySelector('button')).not.toBeNull()
    expect(harness.container.querySelector('[data-native-input-id="unanswered"] [data-send-state="waiting"]')).toBeNull()
  })
  it.each([[1, REMOTE_PROTOCOL_VERSION]])('refuses enqueue when the online host advertises input %s and protocol %s', async (version, protocol) => {
    signIn(`attachment-version-${version}-${protocol}`)
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: protocol } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'attachment-session', nativeInputVersion: version } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="attachment-session" waitingForConnection={false} /></>)
    await act(async () => { await expect(enqueueSessionInput({ deviceId: 'host-a', sessionId: 'attachment-session', text: 'read the file', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })).rejects.toThrow('Update the task host to send attachments') })
    expect(rows()).toEqual([])
    expect(scope.send).not.toHaveBeenCalled()
  })

  it.each(['electron', 'web'])('sends desktop files with explicit input v2 despite missing or stale heartbeat protocol (%s)', async platform => {
    scope.platform = platform
    signIn(`desktop-files-${platform}`)
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'desktop-files', nativeInputVersion: 2 } as never] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }]
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'caption', files })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'following text' })
      await kick()
    })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['caption', 'following text'])
    expect(scope.send.mock.calls[0][0].files).toEqual(files)
    expect(rows()).toEqual([])
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION - 1 } }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'desktop-files', text: 'after host upgrade', files }); await kick() })
    expect(scope.send.mock.calls[2][0].files).toEqual(files)
  })

  it('waits for the desktop input advertisement, then drains files and later text when v2 arrives', async () => {
    signIn('desktop-input-advertisement')
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    updateDeviceSessions('host-a', { cached: false, sessions: [] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }]
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'unknown-input', text: 'caption', files })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'unknown-input', text: 'following text' })
      await kick()
    })
    expect(scope.send).not.toHaveBeenCalled()
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'unknown-input', nativeInputVersion: 2 } as never] })
    await act(async () => { await kick() })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['caption', 'following text'])
    expect(scope.send.mock.calls[0][0].files).toEqual(files)
    expect(rows()).toEqual([])
  })

  it.each([undefined, TASK_ATTACHMENT_PROTOCOL - 1])('drains queued files as caption plus count when a phone returns with protocol %s', async protocol => {
    signIn(`old-phone-${protocol}`)
    scope.devices = []
    scope.phones = [{ device_id: 'phone', is_online: false, capabilities: { host_kind: 'phone' } }]
    scope.send.mockResolvedValue(undefined)
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'phone caption', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'phone', sessionId: 'phone-task', text: 'following text' })
    })
    scope.phones = [{ device_id: 'phone', is_online: true, capabilities: { host_kind: 'phone', ...(protocol !== undefined ? { remote_protocol: protocol } : {}) } }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await kick() })
    expect(scope.send.mock.calls[0][0].text).toMatch(/^phone caption\n\n.*1 attachments/)
    expect(scope.send.mock.calls[0][0]).not.toHaveProperty('files')
    expect(scope.send.mock.calls[1][0].text).toBe('following text')
    expect(rows()).toEqual([])
  })

  it('keeps phone task files compatible at protocol 16 when the desktop learns resumable uploads', async () => {
    signIn('phone-stable-attachment-protocol')
    scope.devices = [{ device_id: 'phone-16', is_online: true, capabilities: { host_kind: 'phone', remote_protocol: TASK_ATTACHMENT_PROTOCOL } }];
    scope.phones = scope.devices as typeof scope.phones;
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />);
    const files = [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }];
    await act(async () => { scope.send.mockResolvedValue({ accepted: true }); await enqueueSessionInput({ deviceId: 'phone-16', sessionId: 'phone-task', text: 'phone caption', files }); await kick(); });
    expect(scope.send.mock.calls[0][0]).toMatchObject({ text: 'phone caption', files });
  });

  it('hands files to the reconnecting host, preserving its caption and draining later text', async () => {
    signIn('expired-attachment-owner')
    scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string; files?: unknown[] }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'expired-task', text: 'original caption', files: [{ itemId: 'gone', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'expired-task', text: 'following text' })
    })
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'expired-task', nativeInputVersion: 2 } as never] })
    await act(async () => { await harness.render(<SessionInputOutboxHost accountId={scope.owner} />); await kick() })
    expect(scope.send.mock.calls.map(([request]) => request.text)).toEqual(['original caption', 'following text'])
    expect(rows()).toEqual([])
    expect(toast).not.toHaveBeenCalled()
  })

  it('sends the caption and omission count on reconnect to an old host, then drains following text', async () => {
    signIn('attachment-reconnect-owner')
    scope.devices = [{ device_id: 'host-a', is_online: false, capabilities: {} }]
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'reconnected-task', text: 'read the file', files: [{ itemId: 'file', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'reconnected-task', text: 'following text' })
    })
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'reconnected-task', nativeInputVersion: 1 } as never] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    const sent = scope.send.mock.calls.map(call => call[0])
    expect(sent[0].text).toMatch(/^read the file\n\n.*1 attachments/)
    expect(sent[0]).not.toHaveProperty('files')
    expect(sent[1].text).toBe('following text')
    await vi.waitFor(async () => expect(rows()).toEqual([]))
  })

  it('retains files and the typed host refusal while custody has not been acknowledged', async () => {
    signIn('attachment-failure-owner')
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION } }]
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'attachment-failure', nativeInputVersion: 2 } as never] })
    scope.send.mockResolvedValue({ ok: false, error: { message: '2 件附件没取到，请重试' } })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="attachment-failure" waitingForConnection={false} /></>)
    const files = ['a', 'b'].map(itemId => ({ itemId, version: 1, name: `${itemId}.txt`, mimeType: 'text/plain', sizeBytes: 3 }))
    await act(async () => { await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'attachment-failure', text: 'read the files', files }) })
    await vi.waitFor(async () => expect(rows()[0]).toMatchObject({ files, failure: { code: 'send-failed', message: '2 件附件没取到，请重试' } }))
    expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ files }))
    expect(rows()[0]?.text).toBe('read the files')
  })
  // A session on this computer may be named by this computer's own device id (the assistant task pane does): its own
  // host answers over IPC, even while the cloud presence row says offline and without a remote input advertisement.
  it.each(['electron', 'web'])('sends comments only to a host that takes them, refusing the rest before queueing (%s)', async platform => {
    scope.platform = platform
    signIn(`annotations-${platform}`)
    const annotations = [{ number: 1, target: 'docs/index.html', comment: 'Make it red', promptText: '# All comments\n\nComment:\nMake it red' }]
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION } }]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'annotated', nativeInputVersion: 2 } as never] })
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await expect(enqueueSessionInput({ deviceId: 'host-a', sessionId: 'annotated', text: 'apply', annotations })).rejects.toThrow('Update the task host to send comments') })
    expect(rows()).toEqual([])
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: { remote_protocol: REMOTE_PROTOCOL_VERSION, task_annotations: 1 } as never }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'annotated', text: 'apply', annotations }); await kick() })
    expect(scope.send).toHaveBeenCalledTimes(1)
    expect(scope.send.mock.calls[0][0]).toMatchObject({ text: 'apply', annotations })
  })

  it('tells the person to update a phone host that does not take comments (iOS), instead of dropping them', async () => {
    signIn('annotations-ios')
    scope.phones = [{ device_id: 'phone-ios', is_online: true, capabilities: { host_kind: 'phone', remote_protocol: 18 } }]
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    const annotations = [{ number: 1, target: 'docs/index.html', comment: 'Make it red', promptText: 'Comment:\nMake it red' }]
    await act(async () => { await expect(enqueueSessionInput({ deviceId: 'phone-ios', sessionId: 'ios-task', text: 'apply', annotations })).rejects.toThrow('Update the task host to send comments') })
    expect(rows()).toEqual([])
    expect(scope.send).not.toHaveBeenCalled()
    scope.phones = []
  })

  it('sends to this computer over IPC when the input names its own device id', async () => {
    signIn('account-own-id')
    scope.devices = [{ device_id: 'this-computer', is_online: false, is_current_device: true, capabilities: {} } as never]
    scope.send.mockImplementation(async (request: { clientMessageId: string }) => ({ ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }))
    await harness.render(<SessionInputOutboxHost accountId={scope.owner} />)
    await act(async () => { await enqueueSessionInput({ deviceId: 'this-computer', sessionId: 'session-own', text: 'Only reply OK' }) })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(1))
    expect(scope.machines).toEqual([null])
  })
  it('does not display another message box while online inputs wait for native acknowledgement', async () => {
    signIn('account-online')
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    let acknowledge!: (value: { ok: true; value: { accepted: string; clientMessageId: string } }) => void
    let currentId = ''
    scope.send.mockImplementation((request: { clientMessageId: string }) => {
      currentId = request.clientMessageId
      return new Promise(resolve => { acknowledge = resolve })
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await act(async () => {
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'First inserted input' })
      await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'Second inserted input' })
    })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(1))
    expect(harness.container.querySelector('[data-native-input-queue]')).toBeNull()
    expect(harness.container.textContent).not.toContain('Waiting for host')
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
    await vi.waitFor(() => expect(scope.send).toHaveBeenCalledTimes(2))
    await act(async () => { acknowledge({ ok: true, value: { accepted: 'queued', clientMessageId: currentId } }) })
  })

  it('previews only the caption and file name while preserving the complete quote for one native delivery', async () => {
    signIn('account-quoted')
    const source = { kind: 'session' as const, sessionId: '135e6cc4-30a6-4ba3-9ffb-46719ba71dc0', itemId: 'turn:s34:message:4c3f357d-efcc-4000-8000-000000000001' }
    const body = '手机排队原话\n@[tri29-file.txt](/Users/test/Documents/tri29-file.txt)'
    const text = messageQuoteText(source, '源消息原文', 'Claude 3') + body
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => {
      scope.received.set(request.clientMessageId, request.text)
      return { ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text }) })
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id] .whitespace-pre-wrap')?.textContent).toBe('手机排队原话\ntri29-file.txt'))
    expect(harness.container.innerHTML).not.toContain('gugu-session://')
    expect(harness.container.innerHTML).not.toContain(source.sessionId)
    expect(harness.container.innerHTML).not.toContain(source.itemId)
    expect(harness.container.innerHTML).not.toContain('/Users/')
    // The host is offline: the input waits for it (and says so), it is not sent.
    await vi.waitFor(() => expect(harness.container.querySelector('[data-send-state="waiting"]')).not.toBeNull())
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await vi.waitFor(() => expect(scope.received.size).toBe(1))
    expect(scope.send).toHaveBeenCalledTimes(1)
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text, clientMessageId: input.id })
    expect(readMessageQuote(scope.received.get(input.id)!)).toEqual(expect.objectContaining({ source, excerpt: '源消息原文', body }))
    await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')).toBeNull())
  })

  it('keeps offline text visibly queued, then sends once when the host returns, without opening a chat envelope', async () => {
    scope.send.mockImplementation(async (request: { clientMessageId: string; text: string }) => {
      scope.received.set(request.clientMessageId, request.text)
      return { ok: true, value: { accepted: 'started', clientMessageId: request.clientMessageId } }
    })
    updateDeviceSessions('host-a', { cached: false, sessions: [{ conversationId: 'session-a', nativeInputVersion: 1 } as never] })
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection /></>)
    let input!: Awaited<ReturnType<typeof enqueueSessionInput>>
    await act(async () => { input = await enqueueSessionInput({ deviceId: 'host-a', sessionId: 'session-a', text: 'offline original' }) })
    await vi.waitFor(() => expect(harness.container.textContent).toContain('offline original'))
    expect(scope.send).not.toHaveBeenCalled()
    scope.devices = [{ device_id: 'host-a', is_online: true, capabilities: {} }]
    await harness.render(<><SessionInputOutboxHost accountId={scope.owner} /><SessionInputQueue sessionId="session-a" waitingForConnection={false} /></>)
    await vi.waitFor(() => expect(scope.received.size, JSON.stringify((window as unknown as Record<string, { rows: unknown }>).__GUGU_NATIVE_INPUT_OUTBOX__?.rows)).toBe(1))
    expect([...scope.received]).toEqual([[input.id, 'offline original']])
    expect(scope.send).toHaveBeenCalledWith({ conversationId: 'session-a', text: 'offline original', clientMessageId: input.id })
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('offline original'))
  })
})
