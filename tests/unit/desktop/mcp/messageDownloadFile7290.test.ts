// #7290 keeps message authority and display filenames when downloading through the device file read host.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { callTool, createGuguImServer } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { verifiedFileHandle } from '../../../support/verifiedFileHandle'
import { attachmentDownloadName } from '../../../../packages/core/src/shared/attachmentDownloadName.mjs'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import { createFileChunkCache, createFileSaver, createFileSink, nodeFileReadStore } from '../../../../packages/core/src/local/files/fileSnapshots'
import { createFileReads, FileReadError, type FileReadOptions, type FileReadRequest, type FileReadResult } from '../../../../packages/core/src/shared/fileReads'
import type { FileHandle, FileProviders, FileRef } from '../../../../packages/core/src/shared/fileResolver'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const LEGACY_URL = 'https://db.test/storage/v1/object/public/chat-media/u/notes.pdf'
const legacy = `[附件] notes.pdf (application/pdf)\n[URL] ${LEGACY_URL}\n[Size] 5\n[Kind] file`
const envelope = '[附件] deck.pdf (application/pdf)\n[Size] 5\n[Kind] file'
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })

function fileRead(file: Promise<FileHandle>, outcome: Partial<Pick<FileReadResult, 'route' | 'reused' | 'waited_ms'>> = {}): FileReadRequest {
  return {
    state$: () => () => {},
    result: file.then(file => ({ file, route: 'oss', reused: null, sha256: file.revision.sha256, waited_ms: 0, ...outcome })),
  }
}

async function setup(message: Record<string, unknown> | null, opts: { agentSees?: boolean; failure?: FileReadError; bytes?: Buffer; wait?: Promise<void> } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'gugu-download-test-'))
  homes.push(home)
  const asked: unknown[] = []
  const fetched: string[] = []
  const deps = {
    restGet: async (path: string) => {
      expect(path).toContain('select=id,chat_id,content,content_type,file_item_id,file_version,file_blob_id')
      return message ? [message] : []
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      // #84 agent 看不见时,会再问一句这条线是不是主人与好友的私聊(这里是群,不是 → 照旧拒)。
      if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: 'group', source_chat_id: null, group_prompt: null }]
      expect([name, body]).toEqual(['can_read_message', { p_message_id: 'm1', p_user_id: AGENT }])
      return opts.agentSees ?? true
    },
    requestFile: (ref: FileRef, actorId: string, options: FileReadOptions) => {
      asked.push([ref]); expect(actorId).toBe(AGENT); expect(options.purpose).toBe('save')
      return fileRead((async () => {
        if (opts.failure) throw opts.failure
        await opts.wait
        fetched.push('verified original')
        return verifiedFileHandle(opts.bytes ?? Buffer.from('bytes'), { file_name: 'notes.pdf', content_type: 'application/pdf' })
      })(), { waited_ms: opts.wait ? 9_000 : 0 })
    },
  }
  const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token', guguHome: home, threadRootId: null }
  const call = () => callTool(context, 'message_download_file', { source_message_id: 'msg:m1' }, deps)
  return { call, asked, fetched, home }
}

describe('message_download_file by source_message_id (#7290)', () => {
  test('makes Windows punctuation and trailing dots or spaces portable without losing Chinese', () => {
    expect(attachmentDownloadName('报告 10:30<>"|?*.html. ')).toBe('报告 10_30______.html')
  })

  test.each(['CON', 'nul.html', 'COM1.txt', 'LPT9', 'COM¹.log'])('escapes reserved Windows device name %s', name => {
    expect(attachmentDownloadName(name)).toBe('_' + name)
  })

  test('limits UTF-8 bytes without splitting Unicode and retains the extension', () => {
    const name = attachmentDownloadName('核对🍵'.repeat(100) + '.html')
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200)
    expect(name.endsWith('.html')).toBe(true)
    expect(name).not.toContain('�')
    expect(name).toMatch(/^(?:核对🍵)*(?:核对|核)?\.html$/u)
  })

  test('a pending read stays with the same device request beyond the old MCP wait', async () => {
    const ready = Promise.withResolvers<void>()
    const { call, asked, fetched } = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null }, { wait: ready.promise })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const read = call()
      await vi.advanceTimersByTimeAsync(9_000)
      expect(asked).toEqual([[{ message_id: 'm1' }]])
      expect(fetched).toEqual([])
      vi.useRealTimers()
      ready.resolve()
      expect(JSON.parse(await read)).toMatchObject({ file_name: 'notes.pdf', route: 'oss', reused: null, waited_ms: 9_000 })
      expect(fetched).toEqual(['verified original'])
    } finally { vi.useRealTimers() }
  })

  test('old message: resolves the message through the same private provider; preserves the original filename', async () => {
    const { call, fetched, asked, home } = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null })
    const text = JSON.stringify(await call())
    expect(fetched).toEqual(['verified original'])
    expect(asked).toEqual([[{ message_id: 'm1' }]])
    const [name] = await readdir(join(home, 'file-store'))
    expect(name).toBe(createHash('sha256').update('bytes').digest('hex'))
    expect(await readFile(join(home, 'file-store', name!, 'notes.pdf'), 'utf8')).toBe('bytes')
    expect(text).toContain(join(home, 'file-store', name!))
  })

  test('preserves a Chinese filename inside its hash directory, so default sending keeps the original name', async () => {
    const fileName = '费用核对报告（最终版）😀.html'
    const { call } = await setup({ id: 'm1', chat_id: CHAT, content: legacy.replace('notes.pdf', fileName), content_type: 'attachment', file_item_id: null, file_version: null })
    const receipt = JSON.parse(await call())
    expect(basename(receipt.file_path)).toBe(fileName)
    expect(basename(dirname(receipt.file_path))).toBe(receipt.sha256)
    expect(await readFile(receipt.file_path, 'utf8')).toBe('bytes')
    expect(attachmentDownloadName('../目录\\报告\u0000\u0085.html')).toBe('..目录报告.html')
    expect(attachmentDownloadName('..')).toBe('attachment')
  })

  test('returns full SHA-256 and actual byte count for the original bytes, including binary and Unicode data', async () => {
    const bytes = Buffer.concat([Buffer.from('原文件😀\n'), Buffer.from([0, 255, 13, 10, 128])])
    const content = legacy.replace('[Size] 5', `[Size] ${bytes.length}`)
    const { call } = await setup({ id: 'm1', chat_id: CHAT, content, content_type: 'attachment', file_item_id: null, file_version: null }, { bytes })
    const receipt = JSON.parse(await call())
    expect(receipt).toMatchObject({ file_name: 'notes.pdf', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(receipt.sha256).toHaveLength(64)
    expect(await readFile(receipt.file_path)).toEqual(bytes)
  })

  test('session attachment shares one transfer, confirms each reader, then reuses the saved file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-session-tool-receipt-')); homes.push(home)
    const bytes = new Uint8Array([0, 255, 65, 13, 10, 128, 9])
    const ref = { attachment_id: '44444444-4444-4444-8444-444444444444', file_name: '原始文件😀.bin', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content_type: 'application/octet-stream' }
    const authorizations: string[] = []
    const downloaded = vi.fn(() => new Response(bytes))
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/file-resolve')) {
        expect(JSON.parse(String(init?.body))).toEqual({ ref: { attachment_id: ref.attachment_id }, as: AGENT })
        authorizations.push(AGENT)
        return Response.json({ ...ref, status: 'ready', source: 'managed-object' })
      }
      if (url.endsWith('/file-download')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ ref: { attachment_id: ref.attachment_id }, as: AGENT, request_id: expect.any(String) })
        return Response.json({ ...ref, status: 'ready', download_id: 'download', url: 'https://objects.test/original' })
      }
      expect(url).toBe('https://objects.test/original'); return downloaded()
    }
    const providers: FileProviders = {
      ...cloudFileProviders({
        endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
        cache: createFileChunkCache(home),
        sink: size => createFileSink(home, size),
      }),
      local: async () => null,
      ssh: async () => null,
    }
    providers.saveTo = createFileSaver(providers)
    const reads = createFileReads(providers, nodeFileReadStore(home))
    const context = {
      agentId: AGENT, guguHome: home, threadRootId: null,
      requestFile: (ref: FileRef, actorId: string, options: FileReadOptions) => reads.request(ref, { accountId: 'owner', actorId }, options),
    }
    const call = async () => JSON.parse(await callTool(context, 'message_download_file', { source_attachment_id: ref.attachment_id }, {}))
    const [first, second] = await Promise.all([call(), call()])
    const file_path = join(home, 'file-store', ref.sha256, ref.file_name)
    for (const receipt of [first, second]) {
      expect(receipt).toMatchObject({ ...ref, file_path, route: 'oss', reused: null, waited_ms: 0, read_only: true })
      expect(receipt).not.toHaveProperty('url')
    }
    expect(new Uint8Array(await readFile(file_path))).toEqual(bytes)
    expect(downloaded).toHaveBeenCalledTimes(1)
    expect(authorizations).toHaveLength(4)
    expect(await call()).toMatchObject({ ...ref, file_path, route: 'local', reused: 'verified-local' })
    expect(downloaded).toHaveBeenCalledTimes(1)
    expect(authorizations).toHaveLength(6)
  })

  test('folder-backed message: resolves its immutable message reference as this agent', async () => {
    const { call, fetched, asked } = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3 })
    const receipt = JSON.parse(await call())
    expect(asked).toEqual([[{ message_id: 'm1' }]])
    expect(fetched).toEqual(['verified original'])
    expect(receipt).toMatchObject({ file: 'gugu-file://item-1?v=3' })
    expect(receipt.next).toContain('message_send {file: "gugu-file://item-1?v=3", file_path}')
  })

  // Preserve X2: the host receives the exact message and agent identity, never the token's owner or a body URL.
  test('the production context resolver receives this agent and the immutable message authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-download-as-')); homes.push(home)
    const calls: unknown[] = []
    const context = { agentId: AGENT, getAccessToken: async () => 'owner-token', guguHome: home, requestFile: (ref: FileRef, actor: string, options: FileReadOptions) => {
      calls.push([ref, actor, options.purpose])
      return fileRead(verifiedFileHandle(Buffer.from('bytes'), { file_name: 'deck.pdf', item_id: 'item-1', version: 3 }), { route: 'ssh' })
    } }
    const receipt = JSON.parse(await callTool(context, 'message_download_file', { source_message_id: 'msg:m1' }, {
      restGet: async () => [{ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3, file_blob_id: null }],
      restRpc: async () => true,
      fetch: async () => { throw Error('No independent object fetch is permitted') },
    }))
    expect(calls).toEqual([[{ message_id: 'm1' }, AGENT, 'save']])
    expect(receipt).toMatchObject({ route: 'ssh', source_message_id: 'msg:m1' })
    expect(await readFile(receipt.file_path, 'utf8')).toBe('bytes')
  })

  test('whisper attachment: retains message-level ACL as this agent', async () => {
    const { call, fetched, asked } = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: null, file_version: null, file_blob_id: 'blob-1' })
    await call()
    expect(asked).toEqual([[{ message_id: 'm1' }]])
    expect(fetched).toEqual(['verified original'])
  })

  test('a folder file by its gugu-file link: resolves that version as this agent and names it back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-download-file-')); homes.push(home)
    const calls: unknown[] = []
    const context = { agentId: AGENT, guguHome: home, requestFile: (ref: FileRef, actor: string) => {
      calls.push([ref, actor])
      return fileRead(verifiedFileHandle(Buffer.from('bytes'), { file_name: 'brief.txt', item_id: '99999999-9999-4999-8999-999999999999', version: 2 }))
    } }
    const receipt = JSON.parse(await callTool(context, 'message_download_file', { file: 'gugu-file://99999999-9999-4999-8999-999999999999?v=2' }, {}))
    expect(calls).toEqual([[{ item_id: '99999999-9999-4999-8999-999999999999', version: 2 }, AGENT]])
    expect(receipt).toMatchObject({ file_name: 'brief.txt', read_only: true, file: 'gugu-file://99999999-9999-4999-8999-999999999999?v=2' })
    // The tool's description stays one line; how to change a shared copy rides in the result that hands it over.
    expect(receipt.note).toContain('copy it to a file of your own')
    expect(await readFile(receipt.file_path, 'utf8')).toBe('bytes')
    await expect(callTool(context, 'message_download_file', { file: 'notes.txt' }, {})).rejects.toThrow('gugu-file://<item_id>?v=<n>')
  })

  test('MCP timeout cancels its waiter and a second call can complete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-download-once-')); homes.push(home)
    const firstStarted = Promise.withResolvers<AbortSignal>()
    const firstCancelled = Promise.withResolvers<void>()
    const secondStarted = Promise.withResolvers<AbortSignal>()
    const finishRead = Promise.withResolvers<void>()
    const requestFile = vi.fn((_ref: FileRef, _actor: string, { signal }: FileReadOptions) => {
      secondStarted.resolve(signal!)
      return fileRead(finishRead.promise.then(() => verifiedFileHandle(Buffer.from('bytes'))))
    }).mockImplementationOnce((_ref, _actor, { signal }) => fileRead(new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        firstCancelled.resolve()
        reject(new FileReadError('cancelled', 'Request cancelled'))
      }, { once: true })
      firstStarted.resolve(signal!)
    })))
    const server = createGuguImServer(() => ({ agentId: AGENT, guguHome: home, requestFile }), { trackRequest: <T,>(work: Promise<T>) => work })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const call = { name: 'message_download_file', arguments: { file: 'gugu-file://99999999-9999-4999-8999-999999999999?v=2' } }
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const first = client.callTool(call, undefined, { timeout: 50 }).catch(error => error)
      const firstSignal = await firstStarted.promise
      const second = client.callTool(call)
      const secondSignal = await secondStarted.promise
      await vi.advanceTimersByTimeAsync(50)
      expect(await first).toMatchObject({ message: expect.stringMatching(/timed out/i) })
      await firstCancelled.promise
      expect(firstSignal.aborted).toBe(true)
      expect(secondSignal.aborted).toBe(false)
      finishRead.resolve()
      expect(await second).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"sha256"') }] })
      expect(requestFile).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      await client.close()
    }
  })

  test('releases the returned handle when saving fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-download-save-failure-')); homes.push(home)
    const file = await verifiedFileHandle(Buffer.from('bytes'))
    const dispose = vi.spyOn(file, 'dispose')
    const failure = new Error('File store is unavailable')
    const context = {
      agentId: AGENT, guguHome: home,
      requestFile: () => fileRead(Promise.resolve({ ...file, saveTo: async () => { throw failure } })),
    }
    await expect(callTool(context, 'message_download_file', { file: 'gugu-file://99999999-9999-4999-8999-999999999999?v=2' })).rejects.toBe(failure)
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('refuses: a message the agent cannot see, one without an attachment, a deleted file, one it may no longer read', async () => {
    const hidden = await setup({ id: 'm1', chat_id: CHAT, content: legacy, content_type: 'attachment', file_item_id: null, file_version: null }, { agentSees: false })
    await expect(hidden.call()).rejects.toThrow('there is no message m1 you can read')
    const text = await setup({ id: 'm1', chat_id: CHAT, content: 'hi', content_type: 'text', file_item_id: null, file_version: null })
    await expect(text.call()).rejects.toThrow('has no attachment')
    const gone = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: null, file_version: 3 })
    await expect(gone.call()).rejects.toThrow('was deleted from the group folder')
    expect(gone.fetched).toEqual([])
    const revoked = new FileReadError('access_revoked', 'File access was revoked')
    const unsigned = await setup({ id: 'm1', chat_id: CHAT, content: envelope, content_type: 'attachment', file_item_id: 'item-1', file_version: 3 }, { failure: revoked })
    await expect(unsigned.call()).rejects.toBe(revoked)
    expect(unsigned.fetched).toEqual([])
  })
})
