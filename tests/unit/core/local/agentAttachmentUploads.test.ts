// An agent's file whose message went out before its bytes has one uploader (agentAttachmentUploads): the tool call asks
// it for its own message; the host asks it for every record the server still lists as pending.
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  rememberAgentUpload, resumeAgentUploads, setAgentUploadHost, uploadAgentFile, type AgentUploadRecord,
} from '../../../../packages/core/src/local/agent/agentAttachmentUploads'
import { AttachmentsError, retryableAttachmentError } from '../../../../packages/core/src/cloud/attachmentsApi'
import { FileDownloadFailure } from '../../../../packages/core/src/cloud/fileDownloadRetry'

const ACCOUNT = 'owner-1', MESSAGE = 'm-1'
let home: string, file: string, bytes: Buffer, previousHome: string | undefined
const logs: string[] = []

function server(rows: () => Array<Record<string, unknown>>, opts: { finish?: number; stored?: number[]; hold?: Promise<void> } = {}) {
  const calls: string[] = []
  const stored = new Set(opts.stored ?? [])
  const fetch = (async (input: string, init: RequestInit = {}) => {
    if (input === 'https://oss.example/form') { calls.push('put'); await opts.hold; return new Response(null, { status: 204 }) }
    if (input.startsWith('https://oss.example/part')) { const n = Number(new URL(input).searchParams.get('n')); calls.push(`put${n}`); return new Response(null, { status: 200 }) }
    const route = input.split('/').at(-1)!
    calls.push(route)
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    if (route === 'pending') return Response.json({ uploads: rows() })
    if (route === 'upload') return Response.json({ staging_key: 'staging/u/new', url: 'https://oss.example/form', fields: {}, max_bytes: Number(body.size_bytes) })
    if (route === 'upload-parts') {
      for (const n of body.done as number[]) stored.add(n)
      const todo = [1, 2, 3].filter(n => !stored.has(n))
      return Response.json({ done: [...stored], todo: todo.map(n => ({ n, bytes: n < 3 ? 6 : 4, url: `https://oss.example/part?n=${n}`, headers: {} })) })
    }
    if (route === 'upload-complete') return Response.json({ staging_key: 'staging/u/parts', size_bytes: 16 })
    if (route === 'finish') return opts.finish ? Response.json({ error: 'upload_changed', message: 'not the declared file' }, { status: opts.finish }) : Response.json({ message: { id: body.message_id } })
    return new Response('unexpected', { status: 500 })
  }) as typeof globalThis.fetch
  return { calls, endpoint: { supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch } }
}
function host(endpoint: ReturnType<typeof server>['endpoint'], account = ACCOUNT) {
  setAgentUploadHost({
    home,
    signedIn: async () => ({ account, endpoint }),
    log: { info: (_f, m) => logs.push(m), warn: (_f, m) => logs.push(m), error: (_f, m) => logs.push(m) },
  })
}
const row = () => ({ staging_key: 'staging/u/declared', message_id: MESSAGE, chat_id: 'chat', as: 'agent', sha256: createHash('sha256').update(bytes).digest('hex'),
  size_bytes: bytes.length, content_type: 'application/octet-stream', file_name: 'report.bin' })
const record = (over: Partial<AgentUploadRecord> = {}): AgentUploadRecord => ({ account: ACCOUNT, message_id: MESSAGE, chat_id: 'chat', as: 'agent',
  staging_key: 'staging/u/declared', path: file, sha256: row().sha256, size_bytes: bytes.length, content_type: 'application/octet-stream', file_name: 'report.bin', ...over })
const remember = (over: Partial<AgentUploadRecord> = {}) => rememberAgentUpload(home, record(over))
const recorded = async () => (await readdir(join(home, 'agent-attachment-uploads')).catch(() => [])).filter(n => n.endsWith('.json'))

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-uploads-'))
  previousHome = process.env.GUGU_HOME
  process.env.GUGU_HOME = home
  bytes = Buffer.from('agent file bytes')
  file = join(home, 'report.bin')
  await writeFile(file, bytes)
  logs.length = 0
})
afterEach(async () => {
  setAgentUploadHost(null)
  vi.useRealTimers()
  if (previousHome === undefined) delete process.env.GUGU_HOME; else process.env.GUGU_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

it('uploads a pending send this machine holds, from its path, and forgets it once finished', async () => {
  const s = server(() => [row()])
  host(s.endpoint)
  await remember()
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending', 'upload', 'put', 'finish'])
  expect(await recorded()).toEqual([])
})

it('one upload per message: the host round joins the upload the tool call is waiting for', async () => {
  let release!: () => void
  const s = server(() => [row()], { hold: new Promise<void>(resolve => { release = resolve }) })
  host(s.endpoint)
  await remember()
  const inCall = uploadAgentFile(home, record(), s.endpoint)
  const round = resumeAgentUploads()
  await vi.waitFor(() => expect(s.calls).toContain('pending'))
  release()
  expect(await inCall).toEqual({ status: 'finished' })
  await round
  expect(s.calls.filter(c => c === 'put')).toHaveLength(1)
  expect(s.calls.filter(c => c === 'finish')).toHaveLength(1)
})

it('a tool call waits for its own message only, not for another file the host is still uploading', async () => {
  const slow = server(() => [], { hold: new Promise<void>(() => undefined) })
  const fast = server(() => [])
  host(fast.endpoint)
  await remember({ message_id: 'm-slow' })
  await remember()
  void uploadAgentFile(home, record({ message_id: 'm-slow' }), slow.endpoint)
  expect(await uploadAgentFile(home, record(), fast.endpoint)).toEqual({ status: 'finished' })
})

it('an upload that fails for a reason worth trying again keeps its record, and the host tries again by itself', async () => {
  // Real timers: the in-call attempts back off 1 s and 2 s, the host's first retry comes 5 s later.
  let down = true
  const s = server(() => [row()])
  const flaky = { ...s.endpoint, fetch: (async (input: string, init?: RequestInit) => {
    if (down && input === 'https://oss.example/form') throw new TypeError('fetch failed')
    return s.endpoint.fetch(input, init)
  }) as typeof globalThis.fetch }
  host(flaky)
  await remember()
  expect(await uploadAgentFile(home, record(), flaky)).toMatchObject({ status: 'retrying' })
  expect(await recorded()).toHaveLength(1)
  down = false
  await vi.waitFor(async () => expect(await recorded()).toEqual([]), { timeout: 8_000, interval: 200 })
  expect(s.calls.at(-1)).toBe('finish')
}, 20_000)

it('a source changed since the send is never uploaded in its place: nothing goes up, the record is dropped, the reason is logged', async () => {
  const s = server(() => [row()])
  host(s.endpoint)
  await remember()
  await writeFile(file, 'other bytes, same length!')
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending'])
  expect(logs).toContain('agent upload source is gone or changed; its bytes are not sent')
  expect(await recorded()).toEqual([])
})

it("another account's send is left as it is; a send the server no longer lists is dropped", async () => {
  const other = server(() => [row()])
  host(other.endpoint, 'someone-else')
  await remember()
  await resumeAgentUploads()
  expect(other.calls).toEqual(['pending'])
  expect(await recorded()).toHaveLength(1)
  const none = server(() => [])
  host(none.endpoint)
  await resumeAgentUploads()
  expect(none.calls).toEqual(['pending'])
  expect(await recorded()).toEqual([])
})

it('a send the server refused is tried once: the record is dropped and nothing is scheduled again', async () => {
  vi.useFakeTimers()
  const s = server(() => [row()], { finish: 409 })
  host(s.endpoint)
  await remember()
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending', 'upload', 'put', 'finish'])
  expect(await recorded()).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('goes on under the upload the bytes were going up under: the parts already stored are not sent again', async () => {
  // 16 bytes in parts of 6: the process died with parts 1 and 2 stored under its multipart upload.
  bytes = Buffer.from('0123456789abcdef')
  await writeFile(file, bytes)
  const s = server(() => [row()], { stored: [1, 2] })
  host(s.endpoint)
  await remember({ plan: { staging_key: 'staging/u/parts', url: '', fields: {}, max_bytes: 16, parts: { part_bytes: 6, count: 3 } } })
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending', 'upload-parts', 'put3', 'upload-parts', 'upload-complete', 'finish'])
  expect(await recorded()).toEqual([])
})

it('a storage request still failing on the network when its own retry window ran out is tried again; a refusal is not', () => {
  // The host met this with the storage unreachable for minutes: each part's retry window ends in a FileDownloadFailure.
  expect(retryableAttachmentError(new FileDownloadFailure('oss', 'https://oss.example/part', 90_000, new TypeError('fetch failed')))).toBe(true)
  expect(retryableAttachmentError(new FileDownloadFailure('oss', 'https://oss.example/part', 90_000, Object.assign(new Error('busy'), { status: 503 })))).toBe(true)
  expect(retryableAttachmentError(new AttachmentsError('finish', 409, 'upload_changed', 'not the declared file'))).toBe(false)
  expect(retryableAttachmentError(new AttachmentsError('upload', 503, 'failed', 'busy'))).toBe(true)
})
