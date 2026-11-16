import { expect, it, vi } from 'vitest'
import type { SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol'
import { completeAttachmentCreation, readAttachmentCreation, submitAttachmentCreation,
  type CreationAttachmentPorts } from '../../../apps/desktop/src/mobile/agent-watch/create-attachment-submission'

function fixture(key: string) {
  const request = { harness: 'codex', prompt: '', clientRequestId: `${key}-request`, initialMessageId: `${key}-message` }
  const files = ['one.txt', 'two.txt'].map((name) => ({ id: name, file: new File([name], name, { type: 'text/plain' }) }))
  const events: string[] = []
  const result: SessionCreateAttachmentDraftResult = { conversationId: 'actual-task', projectId: 'actual-project', title: 'Files',
    attachmentTarget: { agentUserId: 'actual-agent', chatId: 'actual-dm' },
    attachmentDraft: { protocol: 1, clientRequestId: request.clientRequestId, initialMessageId: request.initialMessageId, state: 'awaiting-placement' } }
  const ports: CreationAttachmentPorts = {
    assertAccount: vi.fn(async () => {}),
    describe: vi.fn(async (file) => ({ name: file.name, mimeType: file.type, sizeBytes: file.size, sha256: 'a'.repeat(64) })),
    create: vi.fn(async () => { events.push('create'); return result }),
    place: vi.fn(async (file, target, context) => {
      events.push(`place:${file.name}`)
      expect(target).toMatchObject({ chatId: 'actual-dm', owner: 'owner', sessionId: 'actual-task', deviceId: 'device' })
      const ref = { itemId: file.name, version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size }
      context.published = ref
      return ref
    }),
    admit: vi.fn(async () => { events.push('admit'); return { ...result, attachmentDraft: { ...result.attachmentDraft, state: 'admitted' as const } } }),
  }
  const input = { key, ownerId: 'owner', deviceId: 'device', request, files, ports }
  return { input, result, ports, events }
}

it('creates a file-only first turn, places all original files, then admits the one stable message', async () => {
  const { input, ports, events } = fixture('file-only')
  const receipt = await submitAttachmentCreation(input)
  expect(events).toEqual(['create', 'place:one.txt', 'place:two.txt', 'admit'])
  expect(vi.mocked(ports.create).mock.calls[0]![0]).toMatchObject({ prompt: '', attachments: [{ id: 'one.txt' }, { id: 'two.txt' }] })
  expect(ports.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: 'actual-task',
    clientRequestId: input.request.clientRequestId, initialMessageId: input.request.initialMessageId,
    placements: [expect.objectContaining({ attachmentId: 'one.txt' }), expect.objectContaining({ attachmentId: 'two.txt' })] }))
  completeAttachmentCreation(input.key, receipt.request)
  expect(readAttachmentCreation(input.key)).toBeNull()
})

it('retains the same task, File and per-file placement after a partial upload failure', async () => {
  const { input, ports } = fixture('partial')
  const place = ports.place
  const contexts: unknown[] = []
  let failed = false
  ports.place = vi.fn(async (file, target, context) => {
    if (file.name === 'two.txt') {
      contexts.push(context)
      if (!failed) { failed = true; throw new Error('upload disconnected') }
    }
    return place(file, target, context)
  })
  await expect(submitAttachmentCreation(input)).rejects.toThrow('upload disconnected')
  expect(ports.admit).not.toHaveBeenCalled()
  const original = readAttachmentCreation(input.key)
  await submitAttachmentCreation({ ...input, request: { ...input.request, clientRequestId: 'new-render-request', initialMessageId: 'new-render-message' } })
  expect(ports.create).toHaveBeenCalledTimes(1)
  expect(ports.place).toHaveBeenCalledTimes(3)
  expect(vi.mocked(ports.place).mock.calls[2]![0]).toBe(input.files[1]!.file)
  expect(contexts[1]).toBe(contexts[0])
  expect(vi.mocked(ports.admit).mock.calls[0]![0].initialMessageId).toBe(original!.initialMessageId)
})

it('replays only the same admission when its acknowledgement is lost', async () => {
  const { input, ports, result } = fixture('ack-loss')
  vi.mocked(ports.admit).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ ...result, attachmentDraft: { ...result.attachmentDraft, state: 'admitted' } })
  await expect(submitAttachmentCreation(input)).rejects.toThrow('reply lost')
  await submitAttachmentCreation(input)
  expect(ports.create).toHaveBeenCalledTimes(1)
  expect(ports.place).toHaveBeenCalledTimes(2)
  expect(vi.mocked(ports.admit).mock.calls[0]).toEqual(vi.mocked(ports.admit).mock.calls[1])
})

it('refuses an old host receipt before placing any bytes or admitting text', async () => {
  const { input, ports } = fixture('old-host')
  vi.mocked(ports.create).mockResolvedValue({ conversationId: 'legacy-task', projectId: 'project', title: 'Legacy' } as SessionCreateAttachmentDraftResult)
  await expect(submitAttachmentCreation(input)).rejects.toThrow('attachment protocol')
  expect(ports.place).not.toHaveBeenCalled()
  expect(ports.admit).not.toHaveBeenCalled()
})

it('does not move an uncertain task to another device or edited draft', async () => {
  const { input, ports } = fixture('retarget')
  vi.mocked(ports.create).mockRejectedValueOnce(new Error('host reply lost'))
  await expect(submitAttachmentCreation(input)).rejects.toThrow('host reply lost')
  await expect(submitAttachmentCreation({ ...input, deviceId: 'other-device' })).rejects.toThrow('previous attachment task')
  await expect(submitAttachmentCreation({ ...input, request: { ...input.request, prompt: 'changed' } })).rejects.toThrow('previous attachment task')
  expect(ports.create).toHaveBeenCalledTimes(1)
  expect(ports.place).not.toHaveBeenCalled()
})

it('shares one in-flight submission across duplicate sends/remounts', async () => {
  const { input, ports, result } = fixture('concurrent')
  let resolve!: (value: SessionCreateAttachmentDraftResult) => void
  vi.mocked(ports.create).mockReturnValue(new Promise((done) => { resolve = done }))
  const first = submitAttachmentCreation(input), next = submitAttachmentCreation(input)
  expect(next).toBe(first)
  resolve(result)
  await Promise.all([first, next])
  expect(ports.create).toHaveBeenCalledTimes(1)
  expect(ports.admit).toHaveBeenCalledTimes(1)
})

it('retains an admitted receipt until the page completes its handover, so a remount cannot create the task again', async () => {
  const { input, ports } = fixture('late-page')
  const first = await submitAttachmentCreation(input)
  expect(readAttachmentCreation(input.key)).toBe(first.request)
  const resumed = await submitAttachmentCreation(input)
  expect(resumed.result).toBe(first.result)
  expect(ports.create).toHaveBeenCalledTimes(1)
  expect(ports.place).toHaveBeenCalledTimes(2)
  expect(ports.admit).toHaveBeenCalledTimes(1)
  completeAttachmentCreation(input.key, resumed.request)
})
