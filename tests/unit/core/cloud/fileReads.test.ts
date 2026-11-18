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
    metadata: (actor: string, ref: object) => ({ ...revision, status: 'ready', actor, ref }) as Record<string, unknown> }
  const providers = {
    ...cloudFileProviders({
      cache: createFileChunkCache(root), sink: size => createFileSink(root, size),
      endpoint: async (_context: FileContext) => ({ supabaseUrl: options.backend, token: 'test', anonKey: 'test',
        fetch: async (url, init) => {
          const op = String(url).split('/').at(-1)!, row = JSON.parse(String(init?.body))
          requests.push({ op, ref: row.ref, actor: row.as })
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
      { actor: 'agent', op: 'file-download', ref: { item_id: 'item', version: 3 } },
      { actor: 'agent', op: 'file-resolve', ref: { item_id: 'item', version: 3 } },
    ])
    const repeat = await reads.request(message, account, { purpose: 'save' }).result
    expect(repeat).toMatchObject({ reused: 'verified-local', route: 'local' })
    expect((await saveToFileStore(repeat.file, root)).file_path).toBe(saved.file_path)
    expect(options.gets).toBe(1)
    expect(states.at(-1)).toMatchObject({ status: 'done', route: 'oss' })
  })

  it('runs a private final check even when a peer authorized and verified identical bytes', async () => {
    const { reads, started, bytes, options, requests } = await host()
    const reader = { ...account, actorId: 'agent' }
    const good = reads.request(message, account, { purpose: 'bytes' })
    const refused = reads.request({ attachment_id: 'attachment' }, reader, { purpose: 'bytes' })
    await started.promise
    await vi.waitFor(() => expect(requests.filter(row => row.op === 'file-download')).toHaveLength(2))
    options.metadata = actor => ({ ...revision, status: actor === 'agent' ? 'gone' : 'ready' })
    bytes.release()
    const failure = expect(refused.result).rejects.toMatchObject({ code: 'gone' })
    expect(await (await fileBlob((await good.result).file)).bytes()).toEqual(body)
    await failure
    expect(options.gets).toBe(1)
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

  it('gives each relay reader a private acknowledgement, including a reader joining verified bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-reads-')); roots.push(root)
    const item: FileRevision = { ...revision, source: 'local', host_account_id: 'sender', host_device_id: 'sender-device',
      relative_path: 'sample.bin', host_project_id: 'project', temporary_transfer: true }
    const key = await createFileKey()
    const encrypted = await transformFile({ direction: 'encrypt', revision: item, key,
      source: { size: body.length, read: async (at, length) => body.slice(at, at + length), dispose: async () => {} },
      sink: await createFileSink(root, ciphertextSize(body.length)) })
    const ciphertext = await encrypted.file.read(0, encrypted.file.size)
    await encrypted.file.dispose()
    const acks: { as: string; download_id: string }[] = [], signed: string[] = []
    const bothSigned = gate(), object = vi.fn(async () => { await bothSigned.promise; return new Response(new Uint8Array(ciphertext)) })
    const cloud = cloudFileProviders({ fetch: object, cache: createFileChunkCache(root), sink: size => createFileSink(root, size),
      endpoint: async () => ({ supabaseUrl: 'https://backend.invalid', anonKey: 'test', token: 'test', fetch: async (url, init) => {
        const op = String(url).split('/').at(-1), request = JSON.parse(String(init?.body))
        if (op === 'file-resolve') return Response.json({ ...item, status: 'ready' })
        if (op === 'file-request') {
          signed.push(request.as)
          if (signed.length === 2) bothSigned.release()
          return Response.json({ status: 'ready', transfer_status: 'ready', download: {
            status: 'ready', url: 'https://store.invalid/file', download_id: 'grant-' + request.as,
            sha256: digest, codec: 'secretstream-v1', key: Buffer.from(key).toString('base64'),
            size_bytes: ciphertext.length, ciphertext_bytes: ciphertext.length, ciphertext_sha256: encrypted.ciphertextSha256,
          } })
        }
        if (op !== 'file-read-complete') throw Error(String(op))
        acks.push({ as: request.as, download_id: request.download_id })
        if (request.as === 'refused') return Response.json({ error: 'denied' }, { status: 403 })
        return Response.json({ current: { ...item, status: 'ready' }, acknowledged: true })
      } }),
    })
    const reads = createFileReads({ ...cloud, local: async () => null, ssh: async () => null })
    const good = reads.request(message, account, { purpose: 'save' })
    const refused = reads.request({ item_id: 'item', version: 3 }, { ...account, actorId: 'refused' }, { purpose: 'save' })
    const failed = expect(refused.result).rejects.toMatchObject({ code: 'access_revoked' })
    expect(await (await fileBlob((await good.result).file)).bytes()).toEqual(body)
    await failed
    expect(object).toHaveBeenCalledTimes(1)
    expect(acks).toEqual(expect.arrayContaining([{ as: 'owner', download_id: 'grant-owner' }, { as: 'refused', download_id: 'grant-refused' }]))
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
