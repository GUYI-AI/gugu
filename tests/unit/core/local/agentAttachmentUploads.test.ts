// An agent's file whose message went out before its bytes is finished by its host (agentAttachmentUploads): the
// server's pending list against this machine's records of where the bytes are.
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  agentUploadFailed, forgetAgentUpload, rememberAgentUpload, resumeAgentUploads, resumeAgentUploadsSoon, runAgentUpload, setAgentUploadHost,
} from '../../../../packages/core/src/local/agent/agentAttachmentUploads'
import { AttachmentsError } from '../../../../packages/core/src/cloud/attachmentsApi'

const ACCOUNT = 'owner-1', MESSAGE = 'm-1'
let home: string, file: string, bytes: Buffer, previousHome: string | undefined
const logs: string[] = []

function server(rows: () => Array<Record<string, unknown>>, opts: { finish?: number; stored?: number[] } = {}) {
  const calls: string[] = []
  const stored = new Set(opts.stored ?? [])
  const fetch = (async (input: string, init: RequestInit = {}) => {
    if (input === 'https://oss.example/form') { calls.push('put'); return new Response(null, { status: 204 }) }
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
const remember = (over: Record<string, unknown> = {}) => rememberAgentUpload(home, { account: ACCOUNT, message_id: MESSAGE, path: file, sha256: row().sha256,
  size_bytes: bytes.length, content_type: 'application/octet-stream', file_name: 'report.bin', ...over })
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

it('does not upload twice while the tool call is still uploading the same message in this process', async () => {
  const s = server(() => [row()])
  host(s.endpoint)
  await remember()
  let release!: () => void
  const inCall = runAgentUpload(MESSAGE, () => new Promise<void>(resolve => { release = resolve }))
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending'])
  release()
  await inCall
  await forgetAgentUpload(home, MESSAGE)
})

it('a tool call that gave up hands the upload to the host, which tries again by itself', async () => {
  vi.useFakeTimers()
  const s = server(() => [row()])
  host(s.endpoint)
  await remember()
  resumeAgentUploadsSoon()
  expect(s.calls).toEqual([])
  await vi.advanceTimersByTimeAsync(5_000)
  await vi.waitFor(() => expect(s.calls).toEqual(['pending', 'upload', 'put', 'finish']))
  expect(await recorded()).toEqual([])
})

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
  expect(await agentUploadFailed(home, MESSAGE, new AttachmentsError('finish', 409, 'upload_changed', 'no'))).toBe(false)
  expect(await agentUploadFailed(home, MESSAGE, new TypeError('fetch failed'))).toBe(true)
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
