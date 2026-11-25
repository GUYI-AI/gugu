import { randomUUID } from 'node:crypto'
import { createDeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import { createDeviceRpcRequestEnvelope, parseDeviceRpcReply } from '@gugu/core/cloud/deviceRpcProtocol'
import { FILE_STREAM_PROTOCOL } from '@gugu/core/cloud/serverMachineHealth'
import { requireFileRange, requireFileRevision, type FileBytes, type FileContext, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachSshDeviceRpcPipe, type SharedSshLinks } from './device-rpc-requester'
import { PROJECT_FILE_READ, PROJECT_FILE_STREAM, openProjectFileSource, snapshotProjectFile, type ProjectFileChunk, type ProjectFileReader } from './projectFileHost'

export type HeldFileSshLinks = Pick<SharedSshLinks, 'tap' | 'send' | 'open'> & {
  /** Real owner SSH mappings only; tunnels and connections from another account are excluded. */
  owned(deviceId: string, accountId: string): Promise<boolean>
  /** The open link's remote protocol (null = not open or not said). */
  protocol(deviceId: string): number | null
  /** A read in progress holds the link: the window closing its own use of it waits until the last hold is released. */
  hold(deviceId: string): () => void
}

/** How many times a read starts over from where it got (the link dropped, or nothing came for STREAM_STALL_MS). */
export const STREAM_ATTEMPTS = 6
export const STREAM_STALL_MS = 30_000
/** No bytes for this long: the reader is told the line is stuck (and told again it moves when the next piece lands). */
export const STALL_NOTICE_MS = 3_000
/** The reader's window: about this long at its measured rate (the server keeps no more than it on the line). */
const WINDOW_MS = 2_000
const MIN_WINDOW = 256 * 1024, MAX_WINDOW = 32 * 1024 * 1024
const ACK_EVERY_BYTES = 256 * 1024

/**
 * A version kept on a machine this account reaches over its own SSH link: read over that link and nowhere else (owner
 * 11-22: one path, the file never goes to the cloud). A link that is down is opened again; a read that keeps failing says
 * so. Not an owned SSH machine = null (the resolver's other paths are for those).
 */
export function ownSshFileProvider(links: HeldFileSshLinks, tempRoot: string) {
  return async (revision: FileRevision, context: FileContext) => {
    const deviceId = revision.host_device_id!, accountId = context.actor.accountId
    if (context.actor.actorId !== accountId || revision.host_account_id !== accountId || !await links.owned(deviceId, accountId)) return null
    const release = links.hold(deviceId)
    const requester = createDeviceRpcRequester({ userId: async () => accountId, openPipe: async (device, handlers) => attachSshDeviceRpcPipe(links, device, handlers) })
    let held = false
    try {
      await openLink(links, deviceId)
      const read = async (request: Parameters<ProjectFileReader>[0]) => {
        const response = await requester.call(deviceId, PROJECT_FILE_READ, request, { timeoutMs: 30_000, signal: context.signal })
        if (response.error) throw new Error(`File read refused: ${response.error.code}`)
        return response.result as ProjectFileChunk
      }
      // Protocol 19+: one stream of raw bytes. Older servers answer parts until MIN_SERVER_PROTOCOL reaches FILE_STREAM_PROTOCOL.
      const source = (links.protocol(deviceId) ?? 0) >= FILE_STREAM_PROTOCOL
        ? await openProjectFileStream(revision, { links, deviceId, accountId, signal: context.signal }, context.progress)
        : await openProjectFileSource(revision, read, context.download ? undefined : context.progress)
      // A snapshot is local once it is verified: the link is let go now. A download still reads the line until it is done.
      if (!context.download) return await snapshotProjectFile(revision, source, tempRoot, context.signal)
      held = true
      return { ...source, async dispose() { try { await source.dispose() } finally { release(); requester.closeAll() } } }
    } finally { if (!held) { release(); requester.closeAll() } } // Detach listeners only; the window still owns the SSH link.
  }
}

/**
 * A stream of a file on a machine this desktop reaches over a device link, for a reader in main that is not the file
 * resolver (a working copy's file: `files.stream`). It holds the link while it is read; disposing lets go. Whether the
 * machine is reached over a link (`reaches`) is the same rule the requester's pipe uses (main.ts `linkReaches`), so a
 * read never picks a path from how the link is doing: on a linked machine it streams or fails loudly. Not linked =
 * `linked` is false, and that machine is read the way its channel goes (`@@@cloud-only-pieces` in app-files.ts).
 */
export function remoteFileStreams(links: () => HeldFileSshLinks | null, account: () => Promise<string>,
  reaches: (deviceId: string) => Promise<boolean>) {
  const linkOf = () => {
    const held = links()
    if (!held) throw new Error('The SSH connection to this machine is not available (no device links yet)')
    return held
  }
  return {
    /**
     * A linked machine whose server streams (protocol 19+); it opens the link to ask, as the read will use it. A server
     * below 19 is false: it still has the per-piece reader, over the same link (deleted at protocol 20).
     */
    async linked(deviceId: string): Promise<boolean> {
      if (!await reaches(deviceId)) return false
      const held = linkOf()
      await openLink(held, deviceId)
      const protocol = held.protocol(deviceId)
      if (protocol === null) throw new Error('The SSH connection to this machine closed while it was opened')
      return protocol >= FILE_STREAM_PROTOCOL
    },
    async open(deviceId: string, type: string, request: (offset: number, stream: string, etag?: string) => Record<string, unknown>, pin: { etag?: string }, from: number, signal?: AbortSignal): Promise<LinkStream> {
      const accountId = await account(), held = linkOf()
      const release = held.hold(deviceId)
      try {
        await openLink(held, deviceId)
        const source = await openLinkStream({ links: held, deviceId, accountId, signal }, type, request, pin, undefined, from)
        return { ...source, async dispose() { try { await source.dispose() } finally { release() } } }
      } catch (error) { release(); throw error }
    },
  }
}

async function openLink(links: Pick<HeldFileSshLinks, 'open'>, deviceId: string) {
  const opened = await links.open(deviceId)
  if (!opened.ok && !opened.controlOnly) throw new Error(`The SSH connection to this machine is not available (${opened.reason})`)
}

/**
 * @@@file-stream - a held version as one stream of raw bytes over the device link (`file.stream`, protocol 19); the
 * stream's head says its etag (a server without the head refuses a request with no etag), and a file of another size than the held one is refused. The stream itself
 * is `openLinkStream`.
 */
export async function openProjectFileStream(revision: FileRevision, line: StreamLine, progress?: FileContext['progress']): Promise<FileBytes> {
  requireFileRevision(revision)
  const ref = { item_id: revision.item_id!, version: revision.version! }
  return openLinkStream(line, PROJECT_FILE_STREAM, (offset, stream, etag) => ({ ref, offset, stream, ...(etag ? { etag } : {}) }), { size: revision.size_bytes }, progress)
}

export type StreamLine = { links: HeldFileSshLinks; deviceId: string; accountId: string; signal?: AbortSignal }
export type StreamVersion = { size: number; etag: string }
export type LinkStream = FileBytes & { etag: string }

/**
 * What a server from before the stream head answers a stream request that names no version (its streamers required an etag):
 * read from that answer, not from the version number the link reports, so the read fails on what the machine said.
 */
const OLD_SERVER_REFUSAL = /^Invalid (working copy |file )?stream request$/
export function serverOutdated(): Error {
  return Object.assign(new Error('Gugu on this machine is too old to stream its files: update it, then open the file again'), { code: 'server_outdated' })
}

/** A stream's head (`<type>.head`, device-link-host.ts): the version the machine streams, before its first piece. */
function streamHead(message: unknown, type: string, stream: string): StreamVersion | null {
  const outer = message && typeof message === 'object' ? message as { payload?: unknown } : null
  const head = (outer?.payload && typeof outer.payload === 'object' ? outer.payload : outer) as { type?: unknown; stream?: unknown; size?: unknown; etag?: unknown } | null
  if (head?.type !== `${type}.head` || head.stream !== stream) return null
  if (!Number.isSafeInteger(head.size) || (head.size as number) < 0 || typeof head.etag !== 'string') throw new Error('Invalid file stream head')
  return { size: head.size as number, etag: head.etag }
}

/**
 * A file on another machine as one stream of raw bytes over its device link, from `from` to its end: the server pushes it
 * as fast as the line takes it, inside the window this reader acknowledges (`@@@stream-credit` in device-link-host.ts), so
 * the connection stays full the way scp keeps it. The machine says which version it streams before its first piece (its
 * head), so a read costs one round trip and no call to learn the version first; it resolves with that head. `pin` is what
 * the version must be (a later range of a version this reader has, a held file's size): another is refused ("changed").
 * A link that drops, or a stream that stalls, starts again from the bytes already here, pinned to the head's version.
 * Sequential reads only, as its consumers do.
 */
export function openLinkStream(line: StreamLine, type: string, request: (offset: number, stream: string, etag?: string) => Record<string, unknown>,
  pin: { size?: number; etag?: string }, progress?: FileContext['progress'], from = 0): Promise<LinkStream> {
  const pieces: Buffer[] = []
  let version: StreamVersion | null = null
  let buffered = 0, received = from, consumed = from, failure: Error | null = null, finished = false, stalled = false
  const size = () => version?.size ?? 0
  const stuck = () => { if (!stalled) { stalled = true; progress?.(received, size(), true) } }
  let wake: (() => void) | null = null
  const notify = () => { const w = wake; wake = null; w?.() }
  let headed: (value: StreamVersion) => void = () => undefined
  const head = new Promise<StreamVersion>((resolve) => { headed = resolve })
  const send = (type: string, payload: unknown) => line.links.send(line.deviceId, { type: 'broadcast', event: 'broadcast',
    payload: createDeviceRpcRequestEnvelope(type, randomUUID(), line.accountId, payload) })

  const run = async () => {
    for (let attempt = 1; version === null || received < version.size; attempt++) {
      line.signal?.throwIfAborted()
      if (attempt > STREAM_ATTEMPTS) throw new Error('The connection to this machine kept dropping; the file could not be read. Read it again.')
      if (attempt > 1) { stuck(); await new Promise(resolve => setTimeout(resolve, Math.min(16_000, 1_000 * 2 ** (attempt - 2)))); await openLink(line.links, line.deviceId) }
      const stream = randomUUID().replace(/-/g, ''), requestId = randomUUID()
      const outcome = await new Promise<'done' | 'again'>((resolve, reject) => {
        let lastAt = Date.now(), ackedAt = received, rateFrom = { at: Date.now(), bytes: received }, window = MIN_WINDOW * 4, here: StreamVersion | null = null
        const stall = setInterval(() => {
          if (Date.now() - lastAt > STALL_NOTICE_MS) stuck()
          if (Date.now() - lastAt > STREAM_STALL_MS) finish('again')
        }, 1_000)
        const untap = line.links.tap(line.deviceId, {
          onData(piece) {
            if (piece.stream !== stream) return
            if (!here || piece.offset !== received || received + piece.bytes.length > here.size) return finish(new Error('Invalid file stream piece'))
            pieces.push(piece.bytes); buffered += piece.bytes.length; received += piece.bytes.length; lastAt = Date.now(); stalled = false
            progress?.(received, here.size); notify()
            const elapsed = Date.now() - rateFrom.at
            if (elapsed >= 500) { window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round((received - rateFrom.bytes) / elapsed * WINDOW_MS))); rateFrom = { at: Date.now(), bytes: received } }
            if (received - ackedAt >= ACK_EVERY_BYTES || received === here.size) { ackedAt = received; send(`${type}.ack`, { stream, received, window }) }
          },
          onMessage(message) {
            let said: StreamVersion | null
            try { said = streamHead(message, type, stream) } catch (error) { return finish(error as Error) }
            if (said) {
              const want = version ?? pin
              if ((want.size !== undefined && want.size !== said.size) || (want.etag !== undefined && want.etag !== said.etag)) return finish(new Error('Local file changed during read'))
              if (received > said.size) return finish(new Error('Invalid file stream head'))
              here = said; lastAt = Date.now()
              if (!version) { version = said; headed(said) }
              return
            }
            const reply = parseDeviceRpcReply(message)
            if (reply?.requestId !== requestId) return
            // An answer that is an error is the machine refusing this read (its streamer threw: changed, gone, outside,
            // denied): said at once, never retried as if the line had dropped. A dropped link answers nothing (onClosed).
            if (reply.error) return finish(/changed/i.test(reply.error.message ?? '')
              ? new Error('Local file changed during read') : !here && OLD_SERVER_REFUSAL.test(reply.error.message ?? '') ? serverOutdated()
                : new Error(`The machine refused the file read: ${reply.error.message ?? reply.error.code}`))
            finish(here && received === here.size ? 'done' : new Error('File stream ended before its size'))
          },
          onClosed() { finish('again') },
        })
        const abort = () => finish(line.signal?.reason instanceof Error ? line.signal.reason : new Error('File read aborted'))
        line.signal?.addEventListener('abort', abort, { once: true })
        function finish(result: 'done' | 'again' | Error) {
          clearInterval(stall); untap(); line.signal?.removeEventListener('abort', abort)
          if (result !== 'done') send(`${type}.cancel`, { stream })
          if (result instanceof Error) reject(result); else resolve(result)
        }
        const sent = line.links.send(line.deviceId, { type: 'broadcast', event: 'broadcast',
          payload: createDeviceRpcRequestEnvelope(type, requestId, line.accountId, request(received, stream, version?.etag ?? pin.etag)) })
        if (!sent) finish('again')
      })
      if (outcome === 'done') break
    }
  }
  const ran = run().then(() => { finished = true; notify() }, (error: Error) => { failure = error; notify(); throw error })

  const bytes: FileBytes = { size: 0, dispose: async () => { failure ??= new Error('File stream disposed'); pieces.length = 0 }, async read(offset, length) {
    requireFileRange(size(), offset, length)
    if (offset !== consumed) throw new Error('A file stream is read front to back')
    while (buffered < length) {
      if (failure) throw failure
      if (finished && buffered < length) throw new Error('File stream ended before its size')
      await new Promise<void>(resolve => { wake = resolve })
    }
    const out = new Uint8Array(length)
    for (let at = 0; at < length;) {
      const head = pieces[0]!, take = Math.min(head.length, length - at)
      out.set(head.subarray(0, take), at); at += take
      if (take === head.length) pieces.shift(); else pieces[0] = head.subarray(take)
    }
    buffered -= length; consumed += length
    return out
  } }
  // Resolved by its head; a stream that fails before its head says why.
  return Promise.race([head, ran.then(() => { throw new Error('File stream ended before its head') })]).then((said) => {
    ran.catch(() => undefined)
    return { ...bytes, size: said.size, etag: said.etag }
  }, (error: unknown) => { ran.catch(() => undefined); throw error })
}
