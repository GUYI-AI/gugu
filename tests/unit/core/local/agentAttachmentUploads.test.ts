// An agent's file whose message went out before its bytes is finished by its host (agentAttachmentUploads): the
// server's pending list against this machine's records of where the bytes are.
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  forgetAgentUpload, releaseAgentUpload, rememberAgentUpload, resumeAgentUploads, resumeAgentUploadsSoon, runAgentUpload, setAgentUploadHost,
} from '../../../../packages/core/src/local/agent/agentAttachmentUploads'

const ACCOUNT = 'owner-1', MESSAGE = 'm-1'
let home: string, file: string, bytes: Buffer, previousHome: string | undefined
const logs: string[] = []

function server(rows: () => Array<Record<string, unknown>>) {
  const calls: string[] = []
  const fetch = (async (input: string, init: RequestInit = {}) => {
    if (input === 'https://oss.example/form') { calls.push('put'); return new Response(null, { status: 204 }) }
    const route = input.split('/').at(-1)!
    calls.push(route)
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    if (route === 'pending') return Response.json({ uploads: rows() })
    if (route === 'upload') return Response.json({ staging_key: 'staging/u/new', url: 'https://oss.example/form', fields: {}, max_bytes: Number(body.size_bytes) })
    if (route === 'finish') return Response.json({ message: { id: body.message_id } })
    return new Response('unexpected', { status: 500 })
  }) as typeof globalThis.fetch
  return { calls, endpoint: { supabaseUrl: 'https://project.example', anonKey: 'public', token: 'user', fetch } }
}
function host(endpoint: ReturnType<typeof server>['endpoint'], account = ACCOUNT) {
  setAgentUploadHost({
    signedIn: async () => ({ account, endpoint }),
    log: { info: (_f, m) => logs.push(m), warn: (_f, m) => logs.push(m), error: (_f, m) => logs.push(m) },
  })
}
const row = () => ({ staging_key: 'staging/u/declared', message_id: MESSAGE, chat_id: 'chat', as: 'agent', sha256: createHash('sha256').update(bytes).digest('hex'),
  size_bytes: bytes.length, content_type: 'application/octet-stream', file_name: 'report.bin' })
const remember = (over: Record<string, unknown> = {}) => rememberAgentUpload({ account: ACCOUNT, message_id: MESSAGE, path: file, sha256: row().sha256,
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
  await releaseAgentUpload(MESSAGE)
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
  await forgetAgentUpload(MESSAGE)
})

it('a tool call that gave up hands the upload to the host, which tries again by itself', async () => {
  vi.useFakeTimers()
  const s = server(() => [row()])
  host(s.endpoint)
  await remember()
  await releaseAgentUpload(MESSAGE)
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
  await releaseAgentUpload(MESSAGE)
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
  await releaseAgentUpload(MESSAGE)
  await resumeAgentUploads()
  expect(other.calls).toEqual(['pending'])
  expect(await recorded()).toHaveLength(1)
  const none = server(() => [])
  host(none.endpoint)
  await resumeAgentUploads()
  expect(none.calls).toEqual(['pending'])
  expect(await recorded()).toEqual([])
})

it('a record written by another live process is left to it until that process gives it up', async () => {
  const s = server(() => [row()])
  host(s.endpoint)
  await rememberAgentUpload({ account: ACCOUNT, message_id: MESSAGE, path: file, sha256: row().sha256, size_bytes: bytes.length, content_type: 'application/octet-stream', file_name: 'report.bin' })
  // Pretend the parent (alive) wrote it.
  const { readFile } = await import('node:fs/promises')
  const path = join(home, 'agent-attachment-uploads', `${MESSAGE}.json`)
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), pid: process.ppid }))
  await resumeAgentUploads()
  expect(s.calls).toEqual(['pending'])
  await releaseAgentUpload(MESSAGE)
  await resumeAgentUploads()
  expect(s.calls.slice(1)).toEqual(['pending', 'upload', 'put', 'finish'])
})
