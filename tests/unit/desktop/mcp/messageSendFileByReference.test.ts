import { testAttachmentUploads } from '../../../support/attachmentUploadHost'
// message_send { file }:群文件夹里已有的文件按引用发成附件卡片(不传字节、不建条目);{ file, file_path }:改过的文件发成
// 它的下一版(?v= 是起点版本,服务端用它判冲突)。agent 在投递、历史和下载回执里读到的是同一个 gugu-file 链接。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { attachmentFolderLine } from '../../../../packages/core/src/shared/attachmentFolderLine'

const CHAT = '00000000-0000-4000-8000-000000000001'
const ITEM = '3f88423a-bbca-49f1-9d19-48bb6ee042a5'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const envelope = (size: number) => `[附件] GLM_Agent.pptx (${PPTX})\n[Size] ${size}\n[Kind] file`
const CONTEXT = {
  supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null,
  guguHome: '/tmp/gugu-send-by-reference-test', getAccessToken: async () => 'token',
}
const callTool = (name: string, args: Record<string, unknown>, deps: Record<string, unknown>) => callToolImpl(CONTEXT, name, args, deps)
const localFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-send-by-reference-'))
  const full = join(dir, 'GLM_Agent.pptx')
  writeFileSync(full, 'changed deck')
  return full
})()

function makeDeps(commitAnswer?: (args: Record<string, unknown>) => Response, finishAnswer?: () => Response, currentVersion: () => number = () => 2) {
  const rpcs: Array<[string, Record<string, unknown>]> = []
  const commits: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const shares: Array<Record<string, unknown>> = []
  const finishes: Array<Record<string, unknown>> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) return new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    if (url === 'https://oss.test/') { uploads.push(((init?.body as FormData).get('file') as File).name); return new Response(null, { status: 204 }) }
    if (url.endsWith('/attachments/finish')) {
      finishes.push(JSON.parse(String(init?.body)))
      return finishAnswer?.() ?? new Response(JSON.stringify({ status: 'ready' }))
    }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.endsWith('/attachments/share')) {
      shares.push(args)
      return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: CHAT, content: envelope(64941), content_type: 'attachment', file_item_id: args.item_id, file_version: args.version ?? 2 } }))
    }
    commits.push(args)
    return commitAnswer?.(args)
      ?? new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id, content: envelope(12), file_item_id: ITEM, file_version: 3 } }))
  }) as typeof globalThis.fetch
  const deps: Record<string, unknown> = {
    restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    restInsert: async () => { throw new Error('a file card is never a direct insert') },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      if (name === 'workspace_get_as') return [{ id: ITEM, chat_id: CHAT, kind: 'file', version: currentVersion() }]
      if (name === 'chat_facts') return [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') return [{ user_id: 'agent-1', role: 'member' }]
      return null
    },
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  const attachments = testAttachmentUploads(deps.attachmentsEndpoint as () => Promise<import('@gugu/core/cloud/attachmentsApi').AttachmentsEndpoint>)
  deps.attachments = attachments
  return { deps, rpcs, commits, uploads, shares, finishes, attachments }
}

describe('message_send with a file, by reference', () => {
  test('a committed file with a lost finish response retries finalization without sending the bytes or message again', async () => {
    let finishCalls = 0
    const h = makeDeps(undefined, () => ++finishCalls === 1 ? new Response(JSON.stringify({ error: 'failed' }), { status: 503 }) : new Response(JSON.stringify({ status: 'ready' })))
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file_path: localFile, temporary: true }, h.deps))
    expect(receipt).toMatchObject({ status: 'sent' })
    expect(receipt.upload).toBeUndefined()
    expect(h.commits).toHaveLength(1)
    expect(h.commits[0]).toMatchObject({ keep: 'temporary' })
    expect(h.uploads).toHaveLength(1)
    expect(h.finishes).toHaveLength(2)
    expect(h.finishes[1]).toMatchObject({ message_id: h.commits[0]!.message_id })
  })

  test.each(['upload_mismatch', 'too_large'])('terminal %s reports the committed message and asks against resending it', async reason => {
    const h = makeDeps(undefined, () => new Response(JSON.stringify({ error: reason, message: reason }), { status: reason === 'too_large' ? 413 : 409 }))
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps))
    expect(receipt).toMatchObject({ status: 'sent', upload: 'failed', reason, note: expect.stringContaining('Do not resend the same message') })
    expect(h.commits).toHaveLength(1)
  })

  test('an upload auth failure after commit never triggers outer auth refresh and message replay', async () => {
    const h = makeDeps(undefined, () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }))
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps))
    expect(receipt).toMatchObject({ status: 'sent', upload: 'retrying' })
    expect(h.commits).toHaveLength(1)
  })

  test('a definite commit refusal drops the queued message', async () => {
    const h = makeDeps(() => new Response(JSON.stringify({ error: 'denied', message: 'not allowed' }), { status: 403 }))
    const drop = vi.spyOn(h.attachments, 'drop')
    await expect(callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps)).rejects.toThrow('not allowed')
    expect(drop).toHaveBeenCalledExactlyOnceWith(h.commits[0]!.message_id)
  })

  test.each(['network', '5xx', '408', '429'])('an uncertain %s commit keeps delivering its bytes, even if it only settles an orphan', async kind => {
    const h = makeDeps(() => {
      if (kind === 'network') throw new TypeError('response lost')
      return new Response(JSON.stringify({ error: 'failed' }), { status: kind === '5xx' ? 503 : Number(kind) })
    })
    const drop = vi.spyOn(h.attachments, 'drop')
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps))
    expect(receipt).toMatchObject({ status: 'uncertain', message_id: `msg:${h.commits[0]!.message_id}`, note: expect.stringContaining('Check message_history') })
    expect(h.commits).toHaveLength(3)
    expect(new Set(h.commits.map(commit => commit.message_id)).size).toBe(1)
    expect(drop).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(h.finishes).toHaveLength(1))
  })
  test('a failed recipient read after commit preserves the sent file receipt and never resends', async () => {
    const h = makeDeps(), read = h.deps.restGet as (path: string) => Promise<unknown>
    h.deps.restGet = (path: string) => {
      if (path.startsWith('message_agent_delivery_blocks?')) throw new TypeError('fetch failed')
      return read(path)
    }
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps))
    expect(receipt).toMatchObject({ status: 'sent', delivery_status: 'unverified', file_name: 'GLM_Agent.pptx', size_bytes: 12, mime_type: PPTX,
      message_id: `msg:${h.commits[0]!.message_id}`, file: `gugu-file://${ITEM}?v=3` })
    expect(h.commits).toHaveLength(1)
  })
  test('file alone: one attachments/share call pinned to that version, no upload, no commit; the receipt names the pinned file', async () => {
    const { deps, shares, commits, uploads } = makeDeps()
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=1` }, deps))
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ item_id: ITEM, version: 1, chat_id: CHAT, sender_user_id: 'agent-1', to_user_ids: [] })
    expect(String(shares[0]!.message_id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(uploads).toEqual([])
    expect(commits).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'GLM_Agent.pptx', file: `gugu-file://${ITEM}?v=1`, version: 1 })
  })

  test('file without a version (or a bare item id) sends its current version', async () => {
    for (const file of [`gugu-file://${ITEM}`, ITEM]) {
      const { deps, shares } = makeDeps()
      const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file }, deps))
      expect(shares[0]).toMatchObject({ item_id: ITEM, version: null })
      expect(receipt.file).toBe(`gugu-file://${ITEM}?v=2`)
    }
  })

  test('file + file_path: the upload is committed as that file\'s next version from ?v=, the receipt pins the new version', async () => {
    const { deps, shares, commits, uploads } = makeDeps()
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=2`, file_path: localFile }, deps))
    expect(uploads).toEqual(['GLM_Agent.pptx'])
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ chat_id: CHAT, sender_user_id: 'agent-1', item_id: ITEM, expected_version: 2 })
    expect(shares).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file: `gugu-file://${ITEM}?v=3`, version: 3 })
  })

  test('keep: the commit carries how long the uploaded copy stays; not given, no keep is sent', async () => {
    const temporary = makeDeps()
    await callTool('message_send', { chat_id: CHAT, file_path: localFile, temporary: true }, temporary.deps)
    expect(temporary.commits[0]).toMatchObject({ keep: 'temporary' })
    const plain = makeDeps()
    await callTool('message_send', { chat_id: CHAT, file_path: localFile }, plain.deps)
    expect(plain.commits[0]).not.toHaveProperty('keep')
  })

  // MCP surface review 11-16: one send for text and files — the text goes with the file as its caption, in one message,
  // through the same gates (members, rules, addressing) as a text message.
  test('file with text: one message, the text as its caption, the reply and its addressing carried by the file message', async () => {
    const { deps, shares, commits } = makeDeps()
    deps.restRpc = (async (name: string) => {
      if (name === 'message_history_as') return [{ id: 'source-message', seq: 5, sender_user_id: 'peer-1', is_whisper: false }]
      if (name === 'chat_facts') return [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') return [{ user_id: 'agent-1', role: 'member' }, { user_id: 'peer-1', role: 'member' }]
      return null
    }) as never
    const receipt = JSON.parse(await callTool('message_send', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=1`, text: 'the deck, updated', reply_to_message_id: 'msg:source-message' }, deps))
    expect(commits).toEqual([])
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ item_id: ITEM, caption: 'the deck, updated', reply_to_message_id: 'source-message', to_user_ids: ['peer-1'] })
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'GLM_Agent.pptx' })
  })

  test('file_path with text: the commit carries the caption', async () => {
    const { deps, commits } = makeDeps()
    await callTool('message_send', { chat_id: CHAT, file_path: localFile, text: 'here it is' }, deps)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ caption: 'here it is', file_name: 'GLM_Agent.pptx' })
  })

  test('file_path alone: as before — a new file, no item_id in the commit', async () => {
    const { deps, commits } = makeDeps()
    await callTool('message_send', { chat_id: CHAT, file_path: localFile }, deps)
    expect(commits).toHaveLength(1)
    expect(commits[0]).not.toHaveProperty('item_id')
    expect(commits[0]).not.toHaveProperty('expected_version')
  })

  test('refused before any upload: a next version without the version it starts from; neither file nor file_path; a file that is not a folder link', async () => {
    const { deps, commits, uploads, shares } = makeDeps()
    await expect(callTool('message_send', { chat_id: CHAT, file: `gugu-file://${ITEM}`, file_path: localFile }, deps))
      .rejects.toThrow(`gugu-file://${ITEM}?v=<n>`)
    await expect(callTool('message_send', { chat_id: CHAT }, deps)).rejects.toThrow(/give text, a file \(file \/ file_path\), or both/)
    await expect(callTool('message_send', { chat_id: CHAT, file: 'https://example.test/deck.pptx' }, deps)).rejects.toThrow(/gugu-file:\/\/<item_id>\?v=<n>/)
    expect(uploads).toEqual([])
    expect(commits).toEqual([])
    expect(shares).toEqual([])
  })

  test('a new upload preparation conflict preserves its actual reason without a file reference', async () => {
    const h = makeDeps(() => new Response(JSON.stringify({ error: 'version_conflict', message: 'Upload receipt content changed' }), { status: 409 }))
    await expect(callTool('message_send', { chat_id: CHAT, file_path: localFile }, h.deps)).rejects.toThrow('Upload receipt content changed')
    expect(h.commits).toHaveLength(1)
  })

  test('a newer version stored since: says what to do and that nothing was sent', async () => {
    let version = 2
    const { deps } = makeDeps(() => {
      version = 3
      return new Response(JSON.stringify({ error: 'version_conflict', message: 'workspace item x version conflict: expected 2, got 3' }), { status: 409 })
    }, undefined, () => version)
    await expect(callTool('message_send', { chat_id: CHAT, file: `gugu-file://${ITEM}?v=2`, file_path: localFile }, deps))
      .rejects.toThrow(/newer version .* since version 2, and nothing was sent/)
  })
})

describe('the folder file an agent reads', () => {
  test('history rows carry the pinned file as one link instead of two raw columns', async () => {
    const { deps } = makeDeps()
    const rows = [
      { id: 'm1', content: envelope(5), content_type: 'attachment', file_item_id: ITEM, file_version: 2 },
      { id: 'm2', content: 'hello', content_type: 'text', file_item_id: null, file_version: null },
    ]
    const restRpc = deps.restRpc as (name: string, body: Record<string, unknown>) => Promise<unknown>
    deps.restRpc = async (name: string, body: Record<string, unknown>) => (name === 'message_history_as' ? rows : restRpc(name, body))
    const read = JSON.parse(await callTool('message_history', { chat_id: CHAT }, deps))
    expect(read).toEqual([
      { id: 'msg:m1', content: envelope(5), content_type: 'attachment', file: `gugu-file://${ITEM}?v=2` },
      { id: 'msg:m2', content: 'hello', content_type: 'text' },
    ])
  })

  test('the line names the file, the call that shows it again and the call that sends a change as its next version', () => {
    const line = attachmentFolderLine(ITEM, 2)
    expect(line).toContain(`message_send {file: "gugu-file://${ITEM}?v=2"}`)
    expect(line).toContain(`message_send {file: "gugu-file://${ITEM}?v=2", file_path}`)
    expect(line).toMatch(/next version, never as a new attachment/)
  })
})
