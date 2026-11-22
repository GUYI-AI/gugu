/**
 * A held file over its owner's SSH link as one stream of raw bytes (`file.stream`, remote protocol 19): the frame, the
 * server's credit window, the reader's acknowledgements and resume, and the link a read holds. No real ssh.
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { encodeDataFrame, parseDataFrame, FrameDecoder, FRAME } from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import { createDeviceLinkHost, STREAM_FIRST_WINDOW_BYTES } from '../../../../apps/desktop/electron/server/device-link-host'
import { STALL_NOTICE_MS, openProjectFileStream } from '../../../../apps/desktop/electron/projectFileSsh'
import { registerSshLinkIpc } from '../../../../apps/desktop/electron/server/ssh-link-ipc'
import { SSH_LINK_CHANNELS } from '../../../../apps/desktop/src/lib/sshLink'
import type { FileRevision } from '@gugu/core/shared/fileResolver'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('a stream piece is raw bytes on the line', () => {
  it('round-trips id, offset and bytes through the frame decoder, with no base64', () => {
    const bytes = Buffer.from([0, 1, 2, 255])
    const frame = encodeDataFrame('s1', 5_000_000_000, bytes)
    expect(frame.length).toBe(5 + 1 + 2 + 8 + 4)
    const [decoded] = new FrameDecoder().push(frame)
    expect(decoded!.type).toBe(FRAME.data)
    expect(parseDataFrame(decoded!.payload)).toEqual({ stream: 's1', offset: 5_000_000_000, bytes })
  })
})

describe('the server keeps no more than the reader\'s window on the line', () => {
  const host = (streams: Parameters<typeof createDeviceLinkHost>[0]['streams']) => {
    const messages: unknown[] = [], frames: Buffer[] = []
    const session = createDeviceLinkHost({ userId: () => 'owner', createHandlers: () => ({ handlers: {}, dispose: () => undefined }), streams })(
      message => messages.push(message), async frame => { frames.push(frame) })
    const ask = (type: string, payload: unknown, id = type) => session.handle({ type: 'broadcast', event: 'broadcast', payload: { type, request_id: id, payload } })
    return { session, messages, frames, ask }
  }
  const piece = 256 * 1024
  const pieces = (total: number) => async (_payload: unknown, context: { write(offset: number, bytes: Uint8Array): Promise<void> }) => {
    for (let offset = 0; offset < total; offset += piece) await context.write(offset, new Uint8Array(piece))
    return { size: total }
  }

  it('stops at the window, goes on with each acknowledgement, and answers after the last piece', async () => {
    const total = 8 * piece
    const { messages, frames, ask } = host({ 'file.stream': pieces(total) })
    ask('file.stream', { stream: 'a', offset: 0 }, 'r1')
    await flush()
    expect(frames.length).toBe(STREAM_FIRST_WINDOW_BYTES / piece)
    ask('file.stream.ack', { stream: 'a', received: 2 * piece, window: STREAM_FIRST_WINDOW_BYTES })
    await flush()
    expect(frames.length).toBe(STREAM_FIRST_WINDOW_BYTES / piece + 2)
    ask('file.stream.ack', { stream: 'a', received: total, window: STREAM_FIRST_WINDOW_BYTES })
    await flush(); await flush()
    expect(frames.length).toBe(8)
    expect(JSON.stringify(messages.at(-1))).toContain('"request_id":"r1"')
    expect(JSON.stringify(messages.at(-1))).toContain('"size"')
  })

  it('a cancelled stream stops and says so; a disposed link stops every stream', async () => {
    const { session, messages, frames, ask } = host({ 'file.stream': pieces(16 * piece) })
    ask('file.stream', { stream: 'a', offset: 0 }, 'r1')
    await flush()
    ask('file.stream.cancel', { stream: 'a' })
    await flush(); await flush()
    expect(JSON.stringify(messages.at(-1))).toContain('cancelled')
    const sent = frames.length
    ask('file.stream', { stream: 'b', offset: 0 }, 'r2')
    await flush()
    session.dispose()
    await flush()
    expect(frames.length).toBe(sent + STREAM_FIRST_WINDOW_BYTES / piece)
  })
})

describe('the reader acknowledges, resumes from what it has, and verifies nothing itself (copyVerifiedFile does)', () => {
  const bytes = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251))
  const revision = { item_id: 'item', version: 1, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_type: 'video/mp4',
    source: 'local', chat_id: 'c', file_name: 'v.mp4', relative_path: 'v.mp4', host_account_id: 'owner', host_device_id: 'dev', host_project_id: 'p' } as FileRevision
  const fakeLinks = () => {
    const taps = new Set<{ onMessage(m: unknown): void; onClosed(r: string): void; onData?(p: { stream: string; offset: number; bytes: Buffer }): void }>()
    const sent: { type: string; request_id: string; payload: Record<string, unknown> }[] = []
    const links = {
      tap: (_d: string, handlers: never) => { taps.add(handlers); return () => taps.delete(handlers) },
      send: (_d: string, message: { payload: never }) => { sent.push(message.payload); return true },
      open: async () => ({ ok: true as const }), protocol: () => 19, hold: () => () => undefined, owned: async () => true,
    }
    const push = (stream: string, from: number, to: number) => { for (const tap of [...taps]) tap.onData?.({ stream, offset: from, bytes: bytes.subarray(from, to) }) }
    const reply = (requestId: string, body: unknown) => { for (const tap of [...taps]) tap.onMessage({ type: 'broadcast', event: 'broadcast', payload: { type: 'file.stream:reply', request_id: requestId, ...body as object } }) }
    const closed = () => { for (const tap of [...taps]) tap.onClosed('closed') }
    return { links, sent, push, reply, closed }
  }
  const read = vi.fn(async () => ({ revision, offset: 0, etag: 'etag-1', data: '' }))

  it('reads the whole file, acknowledging as it goes', async () => {
    const line = fakeLinks()
    const source = await openProjectFileStream(revision, read, { links: line.links as never, deviceId: 'dev', accountId: 'owner' })
    await flush()
    const request = line.sent.find(m => m.type === 'file.stream')!
    expect(request.payload).toMatchObject({ offset: 0, etag: 'etag-1' })
    const stream = request.payload.stream as string
    line.push(stream, 0, 300_000); line.push(stream, 300_000, bytes.length)
    line.reply(request.request_id, { result: { size: bytes.length } })
    expect(Buffer.concat([await source.read(0, 400_000), await source.read(400_000, bytes.length - 400_000)]).equals(bytes)).toBe(true)
    expect(line.sent.filter(m => m.type === 'file.stream.ack').at(-1)!.payload).toMatchObject({ stream, received: bytes.length })
  })

  it('a link that drops starts again from the bytes already here, with the same etag', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const line = fakeLinks()
      const source = await openProjectFileStream(revision, read, { links: line.links as never, deviceId: 'dev', accountId: 'owner' })
      await vi.advanceTimersByTimeAsync(0)
      const first = line.sent.find(m => m.type === 'file.stream')!
      line.push(first.payload.stream as string, 0, 300_000)
      line.closed()
      await vi.advanceTimersByTimeAsync(1_000)
      const second = line.sent.filter(m => m.type === 'file.stream').at(-1)!
      expect(second.payload).toMatchObject({ offset: 300_000, etag: 'etag-1' })
      expect(second.payload.stream).not.toBe(first.payload.stream)
      line.push(second.payload.stream as string, 300_000, bytes.length)
      line.reply(second.request_id, { result: { size: bytes.length } })
      expect(Buffer.concat([await source.read(0, 400_000), await source.read(400_000, bytes.length - 400_000)]).equals(bytes)).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('a line with nothing on it is reported stuck, and moving again once bytes land', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    try {
      const line = fakeLinks(), reports: [number, number, true | undefined][] = []
      await openProjectFileStream(revision, read, { links: line.links as never, deviceId: 'dev', accountId: 'owner' }, (done, total, stalled) => reports.push([done, total, stalled]))
      await vi.advanceTimersByTimeAsync(0)
      const request = line.sent.find(m => m.type === 'file.stream')!
      line.push(request.payload.stream as string, 0, 300_000)
      await vi.advanceTimersByTimeAsync(STALL_NOTICE_MS + 1_000)
      expect(reports).toEqual([[300_000, bytes.length, undefined], [300_000, bytes.length, true]])
      line.push(request.payload.stream as string, 300_000, 400_000)
      expect(reports.at(-1)).toEqual([400_000, bytes.length, undefined])
      line.reply(request.request_id, { error: { code: 'stream_failed', message: 'Local file changed during read' } })
    } finally { vi.useRealTimers() }
  })

  it('a file changed on its machine is refused, not resumed', async () => {
    const line = fakeLinks()
    const source = await openProjectFileStream(revision, read, { links: line.links as never, deviceId: 'dev', accountId: 'owner' })
    await flush()
    const request = line.sent.find(m => m.type === 'file.stream')!
    line.reply(request.request_id, { error: { code: 'stream_failed', message: 'Local file changed during read' } })
    await expect(source.read(0, 400_000)).rejects.toThrow('changed')
    expect(line.sent.filter(m => m.type === 'file.stream')).toHaveLength(1)
  })
})

describe('a read in main holds the window\'s link', () => {
  it('the window letting go waits for the read; the machine going away does not', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const links = registerSshLinkIpc({
      ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) } as never,
      getWindow: () => null, store: { list: () => [], onChange: () => () => undefined } as never, currentUserId: async () => 'owner-1',
    })
    const onClosed = vi.fn()
    links.tap('dev', { onMessage: () => undefined, onClosed })
    const release = links.hold('dev')
    handlers.get(SSH_LINK_CHANNELS.close)!({}, 'dev')
    expect(onClosed).not.toHaveBeenCalled()
    release()
    expect(onClosed).toHaveBeenCalledWith('closed')
    const again = links.hold('dev')
    links.close('dev')
    expect(onClosed).toHaveBeenCalledTimes(2)
    again()
  })
})
