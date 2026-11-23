import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — MCP implementation is an untyped ESM module.
import { callTool, TOOL_DEFS, RpcTransportError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { drawImagePreviews } from '../../../../packages/core/src/cloud/attachmentsApi'

// Main registers its image preview drawer at boot; here it never finishes one, so only the send's own requests are seen.
drawImagePreviews({ draw: () => new Promise(() => {}), warn: () => {} })
const friend = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const context = { agentId: 'agent-1', threadRootId: 'unrelated-thread', getAccessToken: async () => '' }
const args = { friend_user_id: `user:${friend}`, text: '明天下午两点见' }

describe('owner-requested friend messages (#7299)', () => {
  it('uses the authenticated owner RPC with the bound Agent and no group or thread', async () => {
    const result = { chat_id: 'owner-friend-dm', message_id: 'sent-1', sent_by_agent: true }
    const restRpc = vi.fn().mockResolvedValue(result)
    const restInsert = vi.fn()
    expect(JSON.parse(await callTool(context, 'message_send_as_owner', args, { restRpc, restInsert }))).toEqual({ ...result, message_id: 'msg:sent-1' })
    expect(restRpc).toHaveBeenCalledExactlyOnceWith('send_friend_message_as_owner', {
      p_agent_user_id: 'agent-1', p_friend_user_id: friend, p_content: args.text, p_request_id: expect.any(String),
    })
    expect(restInsert).not.toHaveBeenCalled()
  })
  it('keeps an internal stable key across lost-response retries', async () => {
    const restRpc = vi.fn().mockRejectedValueOnce(new RpcTransportError()).mockResolvedValue({ chat_id: 'c', message_id: 'm', sent_by_agent: true })
    await callTool(context, 'message_send_as_owner', args, { restRpc })
    expect(restRpc.mock.calls[0]).toEqual(restRpc.mock.calls[1])
  })
  it.each(['', '   '])('rejects blank messages (%j) before sending', async (text) => {
    const restRpc = vi.fn()
    await expect(callTool(context, 'message_send_as_owner', { ...args, text }, { restRpc })).rejects.toThrow('give text, file_path, or both')
    expect(restRpc).not.toHaveBeenCalled()
  })
  it('requires canonical friend addresses and does not expose message keys', async () => {
    const restRpc = vi.fn()
    await expect(callTool(context, 'message_send_as_owner', { ...args, friend_user_id: 'Alice' }, { restRpc })).rejects.toThrow('identity address')
    const def = TOOL_DEFS.find((d: { name: string }) => d.name === 'message_send_as_owner')
    expect(def.schema.shape.request_id).toBeUndefined()
    expect(def.schema.safeParse(args).success).toBe(true)
    expect(restRpc).not.toHaveBeenCalled()
  })
  it('preserves permission failures without retrying', async () => {
    const restRpc = vi.fn().mockRejectedValue(new Error('Selected person is not an owner friend'))
    await expect(callTool(context, 'message_send_as_owner', args, { restRpc })).rejects.toThrow('not an owner friend')
    expect(restRpc).toHaveBeenCalledOnce()
  })
  it('stops after bounded transport retries without changing its stable key', async () => {
    const restRpc = vi.fn().mockRejectedValue(new RpcTransportError())
    await expect(callTool(context, 'message_send_as_owner', args, { restRpc })).rejects.toThrow(RpcTransportError)
    expect(restRpc).toHaveBeenCalledTimes(3)
    expect(restRpc.mock.calls[0]).toEqual(restRpc.mock.calls[2])
  })
  it('does not claim success without an authoritative confirmation', async () => {
    await expect(callTool(context, 'message_send_as_owner', args, { restRpc: async () => ({ status: 'pending' }) })).rejects.toThrow('did not confirm')
  })
})

describe('owner-requested attachments (#7299; #7290 gugu-3: upload, then commit with friend_user_id)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-owner-file-'))
  const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const fileContext = { ...context, getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x` }
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })
  const result = { chat_id: 'owner-friend-dm', message_id: 'attachment-1', sender_user_id: owner, sent_by_agent: true }
  function fixture(name: string, value: Buffer | string = 'report bytes') {
    const file = join(root, name)
    writeFileSync(file, value)
    return file
  }
  /** The attachments function: `answers` says what each commit gets (an answer, an HTTP error, or a transport failure). */
  function deps(answers: Array<'ok' | number | 'lost'> = ['ok'], uploadFails = false, maxBytes = 25 * 1024 * 1024, immutableKeys = false) {
    const uploads: Array<{ name: string; type: string; bytes: Buffer }> = []
    const commits: Array<Record<string, unknown>> = []
    const stored = new Set<string>()
    const fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/attachments/upload')) {
        const request = JSON.parse(String(init?.body))
        expect(request).toMatchObject({ as: context.agentId, chat_id: null, size_bytes: expect.any(Number), request_id: expect.any(String) })
        if (uploadFails) return new Response(JSON.stringify({ error: 'failed', message: 'Storage unavailable' }), { status: 503 })
        const key = `staging/${owner}/${immutableKeys ? request.request_id : 's1'}`
        return Response.json({ staging_key: key, url: 'https://oss.test/', fields: { key }, max_bytes: maxBytes })
      }
      if (url === 'https://oss.test/') {
        const form = init?.body as FormData
        const key = String(form.get('key'))
        if (immutableKeys && stored.has(key)) return new Response(null, { status: 409 })
        stored.add(key)
        const file = form.get('file') as File
        uploads.push({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) })
        return new Response(null, { status: 204 })
      }
      commits.push(JSON.parse(String(init?.body)))
      const answer = answers[Math.min(commits.length, answers.length) - 1]
      if (answer === 'lost') throw new TypeError('fetch failed')
      if (typeof answer === 'number') return new Response(JSON.stringify({ error: 'denied', message: 'Selected person is not an owner friend' }), { status: answer })
      return new Response(JSON.stringify({ message: result }))  // the function answers every commit as { message }
    }) as typeof globalThis.fetch
    const d = {
      restRpc: vi.fn(), restInsert: vi.fn(),
      attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
    }
    return { d, uploads, commits, stored }
  }
  it('keeps two sends of the same file to the same friend independent with immutable storage', async () => {
    const { d, commits, stored } = deps(['ok'], false, 100, true)
    const input = { friend_user_id: args.friend_user_id, file_path: fixture('separate-sends.bin') }
    await callTool(fileContext, 'message_send_as_owner', input, d)
    await callTool(fileContext, 'message_send_as_owner', input, d)
    expect(commits).toHaveLength(2)
    expect(commits[0]!.request_id).not.toBe(commits[1]!.request_id)
    expect([...stored]).toEqual(commits.map(commit => commit.staging_key))
  })
  it.each([
    ['chart.png', '报告.pdf', 'image/png'],
    ['report.pdf', '研究资料.pdf', 'application/pdf'],
  ])('uploads %s unchanged with its type and Chinese name, then commits it to the friend as the owner, naming this agent', async (name, displayName, mime) => {
    const bytes = Buffer.from([0, 1, 255, 10, 128])
    const { d, uploads, commits } = deps()
    const actual = JSON.parse(await callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture(name, bytes), file_name: displayName }, d))
    expect(actual.message_id).toBe('msg:attachment-1')
    expect(uploads).toEqual([{ name: displayName, type: mime, bytes }])
    expect(commits).toEqual([{ staging_key: `staging/${owner}/s1`, friend_user_id: friend, agent_user_id: context.agentId, request_id: expect.any(String), file_name: displayName, content_type: mime }])
    expect(d.restRpc).not.toHaveBeenCalled()
    expect(d.restInsert).not.toHaveBeenCalled()
  })
  it.each(['relative.pdf', root, join(root, 'missing.pdf')])('refuses unreadable paths before uploading: %s', async file_path => {
    const { d, uploads, commits } = deps()
    await expect(callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path }, d)).rejects.toThrow(/absolute|not a file|cannot read/)
    expect([uploads, commits]).toEqual([[], []])
  })
  // The client sets no size limit of its own: the server's upload permit does, and a file over it never leaves this machine.
  it('refuses a file over the server permit with its exact limit, before any byte is stored', async () => {
    const path = fixture('oversize.bin', '')
    truncateSync(path, 25 * 1024 * 1024 + 1)
    const { d, uploads } = deps()
    await expect(callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: path }, d)).rejects.toThrow('a file is at most 26214400')
    expect(uploads).toEqual([])
  })
  it('a file over 25 MiB within the server permit goes up whole, with its type', async () => {
    const path = fixture('large.pdf', '')
    truncateSync(path, 30 * 1024 * 1024)
    const { d, uploads, commits } = deps(['ok'], false, 256 * 1024 * 1024)
    await callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: path }, d)
    expect(uploads.map(({ name, type, bytes }) => ({ name, type, size: bytes.length }))).toEqual([{ name: 'large.pdf', type: 'application/pdf', size: 30 * 1024 * 1024 }])
    expect(commits).toHaveLength(1)
  })
  it('retries a lost signing response within the same send without using another permit', async () => {
    const { d, uploads, commits } = deps()
    const endpoint = await d.attachmentsEndpoint()
    const permits: string[] = []
    d.attachmentsEndpoint = async () => ({ ...endpoint, fetch: (async (url: string, init?: RequestInit) => {
      const response = await endpoint.fetch(url, init)
      if (url.endsWith('/attachments/upload')) {
        permits.push(JSON.parse(String(init?.body)).request_id)
        if (permits.length === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      }
      return response
    }) as typeof globalThis.fetch })
    await callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture('sign-retry.pdf') }, d)
    expect(permits).toEqual([expect.any(String), permits[0]])
    expect(uploads).toHaveLength(1)
    expect(commits).toHaveLength(1)
  })
  it('retries a lost send response with the same upload and request key', async () => {
    const { d, uploads, commits } = deps(['lost', 'ok'])
    await callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture('retry.pdf') }, d)
    expect(uploads).toHaveLength(1)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual(commits[1])
  })
  it('an authoritative rejection is said as it is and not retried', async () => {
    const { d, commits } = deps([403])
    await expect(callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture('rejected.pdf') }, d)).rejects.toThrow('not an owner friend')
    expect(commits).toHaveLength(1)
  })
  it('stops after three ambiguous answers, the same request each time', async () => {
    const { d, commits } = deps(['lost', 'lost', 'lost'])
    await expect(callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture('unknown.pdf') }, d)).rejects.toThrow('fetch failed')
    expect(commits).toHaveLength(3)
    expect(new Set(commits.map((c) => JSON.stringify(c))).size).toBe(1)
  })
  it('never sends a message when the upload fails', async () => {
    const { d, commits } = deps(['ok'], true)
    await expect(callTool(fileContext, 'message_send_as_owner', { friend_user_id: args.friend_user_id, file_path: fixture('upload.pdf') }, d)).rejects.toThrow('Storage unavailable')
    expect(commits).toEqual([])
  })
})
