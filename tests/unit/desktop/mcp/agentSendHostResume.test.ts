// message_send_file sends the message before its bytes, through the host's one uploader. When that upload fails for now,
// its record stays (agentAttachmentUploads) and the call says the message is out and its file still uploading.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const CHAT = '00000000-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const home = mkdtempSync(join(tmpdir(), 'agent-send-resume-'))
const file = join(home, 'report.bin')
let previousHome: string | undefined
beforeAll(() => { previousHome = process.env.GUGU_HOME; process.env.GUGU_HOME = home; writeFileSync(file, 'report bytes') })
afterAll(() => {
  if (previousHome === undefined) delete process.env.GUGU_HOME; else process.env.GUGU_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
const context = {
  supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: CHAT, threadRootId: null, guguHome: home,
  getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: OWNER })).toString('base64url')}.x`,
}

test('a file whose upload the call could not finish is left to the host, and the agent is told not to send it again', async () => {
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) return new Response(JSON.stringify({ staging_key: 'staging/o/1', url: 'https://oss.test/', fields: {}, max_bytes: 1024 }))
    if (url === 'https://oss.test/') return new Response(null, { status: 503 })
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (url.endsWith('/attachments/commit')) return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: CHAT, content: '[附件] report.bin', file_item_id: 'i', file_version: 1 } }))
    return new Response(JSON.stringify({ error: 'invalid', message: `no fake for ${url}` }), { status: 404 })
  }) as typeof globalThis.fetch
  const deps = {
    restGet: async () => [],
    restRpc: async (name: string) => name === 'chat_facts' ? [{ id: CHAT, kind: 'group', source_chat_id: null, group_prompt: null }]
      : name === 'list_member_ids' ? [{ user_id: 'agent-1', role: 'member' }] : null,
    readHostSessionToken: async () => null,
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }),
  }
  const refusal = await callTool(context, 'message_send_file', { chat_id: CHAT, file_path: file }, deps).then(() => null, (error: Error) => error.message)
  expect(refusal).toMatch(/was sent, and its file is still uploading: this host keeps uploading it in the background/)
  expect(refusal).toMatch(/Do not change, move or delete .* until it is done, and do not send it again/)
  const records = readdirSync(join(home, 'agent-attachment-uploads')).filter(name => name.endsWith('.json'))
  expect(records).toHaveLength(1)
  const record = JSON.parse(readFileSync(join(home, 'agent-attachment-uploads', records[0]!), 'utf8'))
  // Nothing is uploading it any more, so the host's next round takes it. A one-request plan is not kept: it starts afresh.
  expect(record).toMatchObject({ account: OWNER, path: file, size_bytes: 12 })
  expect(record.plan).toBeUndefined()
}, 20_000)
