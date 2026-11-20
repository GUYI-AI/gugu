import { testAttachmentUploads } from '../../../support/attachmentUploadHost'
// message_send_file in a project chat: a file goes through this machine's publisher (the composer's) and stays on this
// machine; a folder file's next version, an image's too, is published here from
// the version named, on whichever member's machine sends it.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const CHAT = '00000000-0000-4000-8000-000000000001'
const dir = mkdtempSync(join(tmpdir(), 'gugu-send-project-peer-'))
const pdf = join(dir, 'notes.pdf'), png = join(dir, 'shot.png'), md = join(dir, 'notes.md'), list = join(dir, 'rows.json'), object = join(dir, 'note.json')
writeFileSync(pdf, '%PDF-1.4 fixture'); writeFileSync(png, 'png bytes'); writeFileSync(md, '# shared note\n'); writeFileSync(list, '[1, 2]\n'); writeFileSync(object, '{"updated":true}\n')
const envelope = '[附件] notes.pdf (application/pdf)\n[Size] 16\n[Kind] file'

function setup(options: { publish?: ReturnType<typeof vi.fn>; target?: () => { kind: string; version: number; chat_id?: string }; oldStage?: boolean; commitError?: string } = {}) {
  const uploads: Array<Record<string, unknown>> = []
  const commits: Array<Record<string, unknown>> = []
  const reads: Array<Record<string, unknown>> = []
  // The service already holds this older receipt; a fresh replacement must not clear or consult it.
  const oldStages = options.oldStage ? [{ key: 'staging/o/old', verified: true, consumed: false }] : []
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) {
      uploads.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    }
    if (url === 'https://oss.test/') return new Response(null, { status: 204 })
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.endsWith('/attachments/commit')) {
      commits.push(args)
      if (options.commitError) return new Response(JSON.stringify({ error: 'version_conflict', message: options.commitError }), { status: 409 })
    }
    return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id, content: '[附件] shot.png (image/png)\n[Size] 9\n[Kind] image', file_item_id: '00000000-0000-4000-8000-0000000000aa', file_version: 2 } }))
  }) as typeof globalThis.fetch
  const deps: Record<string, unknown> = {
    restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    restInsert: async () => { throw new Error('a file card is never a direct insert') },
    restRpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'workspace_get_as') { reads.push(args); return [{ id: '00000000-0000-4000-8000-0000000000aa', chat_id: CHAT, ...(options.target?.() ?? { kind: 'file', version: 2 }) }] }
      return name === 'chat_facts' ? [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
        : name === 'list_member_ids' ? [{ user_id: 'agent-1', role: 'member' }] : null
    },
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  deps.attachments = testAttachmentUploads(deps.attachmentsEndpoint as () => Promise<import('@gugu/core/cloud/attachmentsApi').AttachmentsEndpoint>)
  const context = { supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null, guguHome: dir,
    getAccessToken: async () => 'token', ...(options.publish ? { publishFile: options.publish } : {}) }
  return { send: (args: Record<string, unknown>) => callToolImpl(context, 'message_send', { chat_id: CHAT, ...args }, deps), uploads, commits, reads, oldStages }
}

describe('message_send_file in a project chat', () => {
  test('a file other than an image goes through this machine\'s publisher with its message, and no byte is uploaded', async () => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>) => ({ message: { id: message.message_id, chat_id: CHAT, content: envelope } }))
    const { send, uploads } = setup({ publish })
    const receipt = JSON.parse(await send({ file_path: pdf }))
    expect(publish).toHaveBeenCalledOnce()
    const [chat, file, actor, message] = publish.mock.calls[0]!
    expect([chat, actor]).toEqual([CHAT, 'agent-1'])
    expect(file).toEqual({ name: 'notes.pdf', path: pdf, size: 16, contentType: 'application/pdf' })
    expect(message).toMatchObject({ chat_id: CHAT, sender_user_id: 'agent-1', file_name: 'notes.pdf', content_type: 'application/pdf', to_user_ids: [] })
    expect(uploads).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'notes.pdf', message_id: `msg:${message.message_id}` })
  })

  test('an image goes through the same publisher, with its type', async () => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>) => ({ message: { id: message.message_id, chat_id: CHAT, content: envelope } }))
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: png }))).toMatchObject({ status: 'sent', file_name: 'shot.png' })
    expect(publish.mock.calls[0]![1]).toEqual({ name: 'shot.png', path: png, size: 9, contentType: 'image/png' })
    expect(uploads).toEqual([])
  })

  test('a text file the shared classifier makes a document is uploaded for the server to make it one, not published here', async () => {
    const publish = vi.fn()
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: md }))).toMatchObject({ status: 'sent', file_name: 'notes.md' })
    expect(publish).not.toHaveBeenCalled()
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'text/markdown' })])
  })

  test('JSON that is not an object stays stored bytes and is published here', async () => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>) => ({ message: { id: message.message_id, chat_id: CHAT, content: envelope } }))
    const { send, uploads } = setup({ publish })
    expect(JSON.parse(await send({ file_path: list }))).toMatchObject({ status: 'sent' })
    expect(publish).toHaveBeenCalledOnce()
    expect(uploads).toEqual([])
  })

  test('the publisher declines (not a project chat, or this account uploads its files): the ordinary upload sends it', async () => {
    const { send, uploads } = setup({ publish: vi.fn(async () => null) })
    expect(JSON.parse(await send({ file_path: pdf }))).toMatchObject({ status: 'sent', file_name: 'notes.pdf' })
    expect(uploads).toEqual([expect.objectContaining({ content_type: 'application/pdf' })])
  })

  // #719: the next version of a folder file, sent by an agent: published on its own machine, from the version named.
  const ITEM = '00000000-0000-4000-8000-0000000000aa'
  test.each([['a binary PDF', pdf, 'notes.pdf'], ['an image', png, 'shot.png']])('%s\'s next version is published on this machine, from the version named', async (_kind, path, name) => {
    const publish = vi.fn(async (_chat: string, _file: unknown, _actor: string, message: Record<string, unknown>, _next?: unknown) =>
      ({ message: { id: message.message_id, chat_id: CHAT, content: envelope, file_item_id: ITEM, file_version: 3 } }))
    const { send, uploads } = setup({ publish })
    const receipt = JSON.parse(await send({ file: `gugu-file://${ITEM}?v=2`, file_path: path }))
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![1]).toMatchObject({ name, path })
    expect(publish.mock.calls[0]![4]).toEqual({ itemId: ITEM, expectedVersion: 2 })
    expect(uploads).toEqual([])
    expect(receipt).toMatchObject({ status: 'sent', version: 3, file: `gugu-file://${ITEM}?v=3` })
  })

  test('someone stored a newer version first: nothing was sent, and what to do', async () => {
    const { send } = setup({ target: () => ({ kind: 'file', version: 3 }), publish: vi.fn(async () => { throw new Error('File revision conflict') }) })
    const error = await send({ file: `gugu-file://${ITEM}?v=2`, file_path: pdf }).catch((e: Error) => e) as Error
    expect(error.message).toContain(`someone stored a newer version of gugu-file://${ITEM}?v=2 since version 2, and nothing was sent`)
  })
  test.each([false, true])('a live JSON document uses text commit at v1, with an older verified stage=%s', async oldStage => {
    const publish = vi.fn(async () => { throw new Error('File revision conflict') })
    const h = setup({ publish, oldStage, target: () => ({ kind: 'document', version: 1 }) })
    const before = structuredClone(h.oldStages)
    const receipt = JSON.parse(await h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: object, text: 'updated note' }))
    expect(publish).not.toHaveBeenCalled()
    expect(h.reads).toContainEqual({ p_item_id: ITEM, p_as_user_id: 'agent-1' })
    expect(h.commits).toHaveLength(1)
    expect(h.commits[0]).toMatchObject({ item_id: ITEM, expected_version: 1, sender_user_id: 'agent-1', caption: 'updated note', content_type: 'application/json' })
    expect(h.commits[0]!.message_id).toBe(h.uploads[0]!.request_id)
    expect(receipt).toMatchObject({ status: 'sent', file: `gugu-file://${ITEM}?v=2`, version: 2 })
    expect(h.oldStages).toEqual(before)
  })

  test('an existing Markdown document uses the same text replacement path', async () => {
    const publish = vi.fn(async () => { throw new Error('File revision conflict') })
    const h = setup({ publish, target: () => ({ kind: 'document', version: 1 }) })
    await h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: md })
    expect(publish).not.toHaveBeenCalled()
    expect(h.commits).toEqual([expect.objectContaining({ item_id: ITEM, expected_version: 1, content_type: 'text/markdown' })])
  })

  test('a native publication conflict with the same version is not called a newer version or retried as an upload', async () => {
    const publish = vi.fn(async () => { throw new Error('File revision conflict: device publication refused') })
    const h = setup({ publish, target: () => ({ kind: 'file', version: 1 }) })
    const error = await h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: pdf }).catch((error: Error) => error) as Error
    expect(error.message).toContain('device publication refused')
    expect(error.message).not.toContain('someone stored a newer version')
    expect(publish).toHaveBeenCalledOnce()
    expect(h.uploads).toEqual([])
    expect(h.commits).toEqual([])
  })

  test('a non-version text preparation conflict preserves its reason and never enters the native publisher', async () => {
    const publish = vi.fn()
    const h = setup({ publish, target: () => ({ kind: 'document', version: 1 }), commitError: 'Document changed while preparing replacement' })
    const error = await h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: object }).catch((error: Error) => error) as Error
    expect(error.message).toContain('Document changed while preparing replacement')
    expect(error.message).not.toContain('someone stored a newer version')
    expect(publish).not.toHaveBeenCalled()
    expect(h.commits).toHaveLength(1)
  })

  test('a real version change during native publication is confirmed before the newer-version message', async () => {
    let version = 1
    const publish = vi.fn(async () => { version = 2; throw new Error('File revision conflict') })
    const h = setup({ publish, target: () => ({ kind: 'file', version }) })
    await expect(h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: pdf })).rejects.toThrow(/someone stored a newer version/)
    expect(publish).toHaveBeenCalledOnce()
    expect(h.reads).toHaveLength(2)
    expect(h.commits).toEqual([])
  })

  test('a file of another chat is refused before either publication route', async () => {
    const publish = vi.fn()
    const h = setup({ publish, target: () => ({ kind: 'file', version: 1, chat_id: 'another-chat' }) })
    await expect(h.send({ file: `gugu-file://${ITEM}?v=1`, file_path: pdf })).rejects.toThrow(/another chat/)
    expect(publish).not.toHaveBeenCalled()
    expect(h.uploads).toEqual([])
  })

})
