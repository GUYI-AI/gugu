import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import { createFileChunkCache, createFileSaver, createFileSink, nodeFileReadStore, saveToFileStore } from '../../../../packages/core/src/local/files/fileSnapshots'
import { createFileReads, type FileReadState } from '../../../../packages/core/src/shared/fileReads'
import { ciphertextSize, createFileKey, transformFile } from '../../../../packages/core/src/shared/fileCipher'
import { fileBlob, type FileActor, type FileContext, type FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const body = new Uint8Array([11, 13, 17])
const digest = createHash('sha256').update(body).digest('hex')
const revision: FileRevision = { source: 'managed-object', item_id: 'item', version: 3, content_type: 'application/octet-stream', file_name: 'sample.bin', size_bytes: body.length, sha256: digest }
const account: FileActor = { accountId: 'account', actorId: 'owner' }
const message = { message_id: 'message' }
const roots: string[] = []

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'file-reads-')); roots.push(root)
  const started = gate(), bytes = gate()
  const requests: { op: string; actor: string; ref: unknown }[] = []
  const options = { backend: 'https://backend.invalid', pending: false, gets: 0, cancelObserved: false, corrupt: false,
    // The same refusal from the reference's resolve and from its signer (which resolves first).
    refuse: undefined as undefined | (() => Response),
    metadata: (actor: string, ref: object) => ({ ...revision, status: 'ready', actor, ref }) as Record<string, unknown> }
  const providers = {
    ...cloudFileProviders({
      cache: createFileChunkCache(root), sink: size => createFileSink(root, size),
      endpoint: async (_context: FileContext) => ({ supabaseUrl: options.backend, token: 'test', anonKey: 'test',
        fetch: async (url, init) => {
          const op = String(url).split('/').at(-1)!, row = JSON.parse(String(init?.body))
          requests.push({ op, ref: row.ref, actor: row.as })
          if (options.refuse && (op === 'file-resolve' || op === 'file-download')) return options.refuse()
          if (op === 'file-resolve') return Response.json(options.pending
            ? { status: 'missing', code: 'object_not_found', upload: 'pending' } : options.metadata(row.as, row.ref))
          if (op !== 'file-download') throw Error(op)
          return Response.json({ ...options.metadata(row.as, row.ref), status: 'ready', url: 'https://storage.invalid/file', download_id: crypto.randomUUID() })
        },
      }),
      fetch: async (_url, init) => {
        options.gets++; started.release()
        const cancelled = () => { options.cancelObserved = true; bytes.release() }
        init?.signal?.addEventListener('abort', cancelled, { once: true })
        await bytes.promise
        init?.signal?.removeEventListener('abort', cancelled)
        init?.signal?.throwIfAborted()
        return new Response(options.corrupt ? new Uint8Array([1, 2, 3]) : body)
      },
    }),
    local: async () => null, ssh: async () => null,
  }
  const reads = createFileReads({ ...providers, saveTo: createFileSaver(providers) }, nodeFileReadStore(root))
  return { root, options, requests, reads, started, bytes }
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('device file reads', () => {
  it('joins aliases across actors, retains the surviving waiter and pins the current item version', async () => {
    const { reads, started, bytes, options, requests, root } = await host()
    const cancel = new AbortController()
    const first = reads.request(message, account, { purpose: 'bytes', signal: cancel.signal })
    await started.promise
    const second = reads.request({ item_id: 'item' }, { ...account, actorId: 'agent' }, { purpose: 'save' })
    const states: FileReadState[] = []
    second.state$(state => states.push(state))
    await vi.waitFor(() => expect(states.some(state => state.status === 'transferring')).toBe(true))
    cancel.abort()
    await expect(first.result).rejects.toMatchObject({ code: 'cancelled' })
    expect(options.cancelObserved).toBe(false)
    bytes.release()
    const result = await second.result
    const saved = await saveToFileStore(result.file, root)
    expect(await readFile(saved.file_path)).toEqual(Buffer.from(body))
    expect(options.gets).toBe(1)
    expect(requests.filter(row => row.actor === 'agent')).toEqual([
      { actor: 'agent', op: 'file-resolve', ref: { item_id: 'item' } },
      { actor: 'agent', op: 'file-resolve', ref: { item_id: 'item', version: 3 } },
    ])
    expect(requests.filter(row => row.op === 'file-download')).toHaveLength(1)
    const beforeRepeat = requests.length
    const repeatRequest = reads.request(message, account, { purpose: 'save' })
    const repeatStates: FileReadState[] = []
    repeatRequest.state$(state => repeatStates.push(state))
    const repeat = await repeatRequest.result
    expect(repeatStates.filter(state => state.status === 'transferring').map(state => state.route)).toEqual(['local'])
    expect(repeat).toMatchObject({ reused: 'verified-local', route: 'local' })
    expect((await saveToFileStore(repeat.file, root)).file_path).toBe(saved.file_path)
    expect(options.gets).toBe(1)
    expect(requests.slice(beforeRepeat)).toEqual([
      { actor: 'owner', op: 'file-resolve', ref: message },
      { actor: 'owner', op: 'file-resolve', ref: message },
    ])
    expect(states.at(-1)).toMatchObject({ status: 'done', route: 'oss' })
  })

  it('runs a private final check even when a peer authorized and verified identical bytes', async () => {
    const { reads, started, bytes, options, requests } = await host()
    const reader = { ...account, actorId: 'agent' }
    const good = reads.request(message, account, { purpose: 'bytes' })
    const refused = reads.request({ attachment_id: 'attachment' }, reader, { purpose: 'bytes' })
    await started.promise
    const joined = gate()
    refused.state$(state => { if (state.status === 'transferring') joined.release() })
    await joined.promise
    options.metadata = actor => ({ ...revision, status: actor === 'agent' ? 'gone' : 'ready' })
    bytes.release()
    const failure = expect(refused.result).rejects.toMatchObject({ code: 'gone' })
    expect(await (await fileBlob((await good.result).file)).bytes()).toEqual(body)
    await failure
    // The peer's refusal changes nothing for the authorized reader. A finished read keeps no chunks, so its repeat reads
    // again, as it would with no peer at all.
    const retry = await reads.request(message, account, { purpose: 'bytes' }).result
    expect(await (await fileBlob(retry.file)).bytes()).toEqual(body)
    expect(retry.reused).toBeNull()
    expect(requests.filter(row => row.op === 'file-download')).toHaveLength(2)
    expect(options.gets).toBe(2)
  })

  it.each(['account', 'backend'])('isolates both the verified store and raw chunk cache by %s', async scope => {
    const { reads, bytes, options, root } = await host()
    bytes.release()
    const saved = await saveToFileStore((await reads.request(message, account, { purpose: 'save' }).result).file, root)
    if (scope === 'backend') options.backend = 'https://another.invalid'
    const actor = scope === 'account' ? { ...account, accountId: 'other' } : account
    const result = await reads.request(message, actor, { purpose: 'save' }).result
    expect(result).toMatchObject({ route: 'oss', reused: null })
    expect((await saveToFileStore(result.file, root)).file_path).toBe(saved.file_path)
    expect(options.gets).toBe(2)
  })

  it('never joins or caches historical objects without a digest', async () => {
    const { reads, started, bytes, options } = await host()
    options.metadata = () => ({ ...revision, item_id: undefined, version: undefined, sha256: null, bucket_id: 'chat-media', message_id: 'message', object_name: 'historical', status: 'ready' })
    const one = reads.request(message, account, { purpose: 'bytes' })
    const two = reads.request(message, account, { purpose: 'bytes' })
    await started.promise
    await vi.waitFor(() => expect(options.gets).toBe(2))
    bytes.release()
    for (const request of [one, two]) expect(await (await fileBlob((await request.result).file)).bytes()).toEqual(body)
  })

  it('nudges a pending declaration and reports integrity failure without delivering a file', async () => {
    const { reads, bytes, options } = await host()
    bytes.release(); options.pending = true; options.corrupt = true
    const states: FileReadState[] = []
    const request = reads.request(message, account, { purpose: 'bytes' })
    request.state$(state => {
      states.push(state)
      if (state.status === 'waiting_sender') { options.pending = false; reads.nudge() }
    })
    await expect(request.result).rejects.toMatchObject({ code: 'integrity_failed' })
    expect(states[0]).toMatchObject({ status: 'waiting_sender', reason: 'declared' })
    expect(states.at(-1)).toMatchObject({ status: 'failed', code: 'integrity_failed' })
  })

  it.each([
    { retention: '7d', separate: false, expected: 1 },
    { retention: '7d', separate: true, expected: 2 },
    { retention: 'read-once', separate: true, expected: 2 },
    { retention: undefined, separate: false, expected: 2 },
  ])('checks each relay reader and binds sharing to a reusable generation ($retention, separate=$separate)', async ({ retention, separate, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-reads-')); roots.push(root)
    const item: FileRevision = { ...revision, source: 'local', host_account_id: 'sender', host_device_id: 'sender-device',
      relative_path: 'sample.bin', host_project_id: 'project', temporary_transfer: true }
    const key = await createFileKey()
    const encrypted = await transformFile({ direction: 'encrypt', revision: item, key,
      source: { size: body.length, read: async (at, length) => body.slice(at, at + length), dispose: async () => {} },
      sink: await createFileSink(root, ciphertextSize(body.length)) })
    const ciphertext = await encrypted.file.read(0, encrypted.file.size)
    await encrypted.file.dispose()
    const acks: string[] = [], signed: string[] = [], admitted: string[] = [], resolutions: string[] = []
    const preparations = new Set<string>()
    const permits = new Map<string, { actor: string; ref: unknown }>()
    let revoked = false, wrongGeneration = false, newGeneration = false
    let bytes = gate()
    const object = vi.fn(async () => { await bytes.promise; return new Response(new Uint8Array(ciphertext)) })
    const cloud = cloudFileProviders({ fetch: object, cache: createFileChunkCache(root), sink: size => createFileSink(root, size),
      endpoint: async () => ({ supabaseUrl: 'https://backend.invalid', anonKey: 'test', token: 'test', fetch: async (url, init) => {
        const op = String(url).split('/').at(-1), request = JSON.parse(String(init?.body))
        const current = { ...item, status: 'ready', temporary_transfer: !(revoked && request.as === 'refused') }
        if (op === 'file-resolve') { resolutions.push(request.as); return Response.json(current) }
        if (op === 'file-request') {
          const generation = newGeneration ? 'next' : separate ? 'transfer-' + request.as : 'shared'
          const state = { ...current, transfer_status: 'ready', transfer_id: generation, retention }
          if (!request.download_request_id) {
            expect(preparations.has(request.request_id)).toBe(false)
            preparations.add(request.request_id); admitted.push(request.as)
            return Response.json(state)
          }
          expect(preparations.has(request.request_id)).toBe(true)
          signed.push(request.as)
          permits.set(request.download_request_id, { actor: request.as, ref: request.ref })
          return Response.json({ ...state, download: {
            status: 'ready', url: 'https://store.invalid/file', download_id: request.download_request_id, transfer_id: wrongGeneration ? 'other' : generation,
            sha256: digest, codec: 'secretstream-v1', key: Buffer.from(key).toString('base64'),
            size_bytes: ciphertext.length, ciphertext_bytes: ciphertext.length, ciphertext_sha256: encrypted.ciphertextSha256,
          } })
        }
        if (op !== 'file-read-complete') throw Error(String(op))
        expect(permits.get(request.download_id)).toEqual({ actor: request.as, ref: request.ref })
        acks.push(request.as)
        return Response.json({ current, acknowledged: true })
      } }),
    })
    const providers = { ...cloud, local: async () => null, ssh: async () => null }
    const reads = createFileReads({ ...providers, saveTo: createFileSaver(providers) }, nodeFileReadStore(root))
    const good = reads.request(message, account, { purpose: 'save' })
    await vi.waitFor(() => expect(object).toHaveBeenCalledTimes(1))
    const repeated = reads.request(message, account, { purpose: 'bytes' })
    const repeatedJoined = gate()
    repeated.state$(state => { if (state.status === 'transferring') repeatedJoined.release() })
    await repeatedJoined.promise
    const refused = reads.request({ item_id: 'item', version: 3 }, { ...account, actorId: 'refused' }, { purpose: 'save' })
    const joined = gate()
    refused.state$(state => { if (state.status === 'transferring') joined.release() })
    await joined.promise
    const failed = expect(refused.result).rejects.toMatchObject({ code: 'access_revoked' })
    revoked = true
    bytes.release()
    const held = (await repeated.result).file
    const saved = await saveToFileStore((await good.result).file, root)
    expect(await readFile(saved.file_path)).toEqual(Buffer.from(body))
    await failed
    expect(admitted).toEqual(['owner', 'refused'])
    expect(resolutions.filter(actor => actor === 'owner')).toHaveLength(4)
    expect(object).toHaveBeenCalledTimes(expected)
    expect(signed).toHaveLength(expected)
    expect(acks.sort()).toEqual(signed.slice().sort())
    const retry = await reads.request(message, account, { purpose: 'bytes' }).result
    expect(await (await fileBlob(retry.file)).bytes()).toEqual(body)
    const extra = retention === '7d' ? 0 : 1
    expect(object).toHaveBeenCalledTimes(expected + extra)
    expect(signed).toHaveLength(expected + extra)
    expect(acks).toHaveLength(expected + extra)
    expect(admitted).toEqual(['owner', 'refused', 'owner'])
    await held.dispose()
    if (retention === 'read-once') {
      const previous = object.mock.calls.length
      bytes = gate()
      const byMessage = reads.request(message, account, { purpose: 'bytes' })
      const byItem = reads.request({ item_id: 'item', version: 3 }, account, { purpose: 'bytes' })
      await vi.waitFor(() => expect(object).toHaveBeenCalledTimes(previous + 2))
      bytes.release()
      await Promise.all([byMessage, byItem].map(async entry => (await entry.result).file.dispose()))
      expect(acks).toHaveLength(previous + 2)
    }
    const getsBeforeMismatch = object.mock.calls.length
    newGeneration = true; wrongGeneration = true
    await expect(reads.request(message, account, { purpose: 'bytes' }).result).rejects.toMatchObject({ code: 'access_revoked' })
    expect(object).toHaveBeenCalledTimes(getsBeforeMismatch)
    key.fill(0)
  })

  it('aborts storage I/O when the final reader leaves', async () => {
    const { reads, started, options } = await host()
    const cancel = new AbortController()
    const request = reads.request(message, account, { purpose: 'bytes', signal: cancel.signal })
    await started.promise
    cancel.abort()
    await expect(request.result).rejects.toMatchObject({ code: 'cancelled' })
    expect(options.cancelObserved).toBe(true)
  })
})

describe('a managed fetch admitted by its own signed download (contract §2.1 step 1, amended)', () => {
  const projected = { status: 'ready' as const, revision }
  const settle = async (h: Awaited<ReturnType<typeof host>>) => { await h.started.promise; h.bytes.release() }

  it('signs once as its authorization and pin, fetches through that capability, and still rechecks before handing out', async () => {
    const h = await host()
    const request = h.reads.request(message, account, { purpose: 'bytes', admit: projected })
    await settle(h)
    const { file } = await request.result
    expect(await fileBlob(file).then(blob => blob.arrayBuffer())).toEqual(body.buffer)
    expect(h.requests.map(row => row.op)).toEqual(['file-download', 'file-resolve'])
    expect(h.options.gets).toBe(1)
  })

  it('refuses a projection the signer does not confirm before any byte request (condition 1)', async () => {
    const h = await host()
    const other = { status: 'ready' as const, revision: { ...revision, sha256: 'f'.repeat(64) } }
    await expect(h.reads.request(message, account, { purpose: 'bytes', admit: other }).result).rejects.toMatchObject({ code: 'access_revoked' })
    expect(h.requests.map(row => row.op)).toEqual(['file-download'])
    // Nothing fetched: the unused reservation closes through the server's unused-download settlement (#325).
    expect(h.options.gets).toBe(0)
  })

  it('a request joining a running fetch does its own pure file-resolve first (condition 2)', async () => {
    const h = await host()
    const first = h.reads.request(message, account, { purpose: 'bytes', admit: projected })
    await h.started.promise
    const agent = { accountId: 'account', actorId: 'agent' }
    const second = h.reads.request({ item_id: 'item', version: 3 }, agent, { purpose: 'bytes', admit: projected })
    await vi.waitFor(() => expect(h.requests.filter(row => row.actor === 'agent').map(row => row.op)).toEqual(['file-resolve']))
    h.bytes.release()
    await Promise.all([first.result, second.result])
    expect(h.requests.filter(row => row.op === 'file-download').map(row => row.actor)).toEqual(['owner'])
    expect(h.options.gets).toBe(1)
  })

  it('a verified local copy is handed out only after a pure file-resolve (condition 4)', async () => {
    const h = await host()
    h.bytes.release()
    await saveToFileStore((await h.reads.request(message, account, { purpose: 'save' }).result).file, h.root)
    h.requests.length = 0
    const again = await h.reads.request(message, account, { purpose: 'bytes', admit: projected }).result
    expect(h.requests[0]?.op).toBe('file-resolve')
    expect(again).toMatchObject({ reused: 'verified-local' })
    await again.file.dispose()
  })

  it('an item ref is pinned by the signer row; the recheck after the bytes asks for that pinned version, not the current one', async () => {
    const h = await host()
    // The projection is only a claim (an older version label with the same bytes); the signer row names version 3.
    const stale = { status: 'ready' as const, revision: { ...revision, version: 2 } }
    // After signing, the item moves on: an unpinned ref now resolves to version 4.
    let moved = false
    h.options.metadata = (actor, ref) => ({ ...revision, status: 'ready', actor, ref,
      version: moved && !('version' in ref) ? 4 : 'version' in ref ? (ref as { version: number }).version : 3 })
    const request = h.reads.request({ item_id: 'item' }, account, { purpose: 'bytes', admit: stale })
    await h.started.promise
    moved = true
    h.bytes.release()
    const { file } = await request.result
    expect(file.revision).toMatchObject({ item_id: 'item', version: 3 })
    expect(h.requests.map(row => [row.op, row.ref])).toEqual([['file-download', { item_id: 'item' }], ['file-resolve', { item_id: 'item', version: 3 }]])
    expect(await fileBlob(file).then(blob => blob.arrayBuffer())).toEqual(body.buffer)
  })

  it.each([
    ['gone', () => Response.json({ status: 'gone', sha256: null })],
    ['expired', () => Response.json({ status: 'expired', sha256: null })],
    ['refused', () => Response.json({ error: 'denied', code: 'file_transfer_denied' }, { status: 403 })],
  ])('maps a %s answer to the same failure as a resolve would (conditions 3, 6): no signature used, no bytes', async (_label, answer) => {
    const viaResolve = await host(), viaSigner = await host()
    viaResolve.options.refuse = answer; viaSigner.options.refuse = answer
    const resolved = await viaResolve.reads.request(message, account, { purpose: 'bytes' }).result.catch((error: unknown) => error)
    const signed = await viaSigner.reads.request(message, account, { purpose: 'bytes', admit: projected }).result.catch((error: unknown) => error)
    expect(signed).toMatchObject({ code: (resolved as { code: string }).code })
    expect(viaSigner.requests.map(row => row.op)).toEqual(['file-download'])
    expect(viaSigner.options.gets).toBe(0)
  })
})
