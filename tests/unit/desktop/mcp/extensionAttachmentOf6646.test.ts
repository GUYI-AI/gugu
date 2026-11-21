// #6646 app_install { source_message_id }: the host reads the message — only in a chat this agent is in — and hands on
// the attachment's URL. The agent names a message; a URL is never its word (who published it, the install reads).
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { extensionAttachmentOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const URL = 'https://db.test/storage/v1/object/public/chat-media/u/share-1.0.0.guguext'
const attachment = (fileName: string, mime: string) => `[附件] ${fileName} (${mime})\n[URL] ${URL}\n[Size] 409\n[Kind] file`
const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' }

// The message is read once, as the agent (chat.messages_by_id_as: membership, history floor, whisper parties — the rule
// message_history reads by). Not a member, or a whisper it is no party to: no row.
function injected(content = attachment('share-1.0.0.guguext', 'application/vnd.gugu.extension+zip'), agentSees = true, fileRef: Record<string, unknown> = {}) {
  return {
    restGet: async (path: string) => { throw new Error(`unexpected read ${path}`) },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      expect(name).toBe('messages_by_id_as')
      expect(body.p_as).toBe(AGENT)
      return agentSees && body.p_id === 'm1' ? [{ id: 'm1', chat_id: CHAT, content, ...fileRef }] : []
    },
  }
}

describe('app_install from a chat message (#6646)', () => {
  test('hands on the card\'s message, an old card too (#7290) — never its URL', async () => {
    await expect(extensionAttachmentOf(context, 'm1', injected())).resolves.toEqual({ message_id: 'm1', reader: AGENT })
  })

  // #6835 A chat the agent is not in, or a whisper that is not the agent's: no message, and no hint that one is there.
  test('refuses what the agent cannot read, exactly as a missing message', async () => {
    await expect(extensionAttachmentOf(context, 'm1', injected(undefined, false)))
      .rejects.toThrow('there is no message m1 you can read')
  })

  test('refuses a message it cannot read, and one whose attachment is not an extension package', async () => {
    await expect(extensionAttachmentOf(context, 'm2', injected())).rejects.toThrow('there is no message m2 you can read')
    await expect(extensionAttachmentOf(context, 'm1', injected(attachment('notes.pdf', 'application/pdf'))))
      .rejects.toThrow('message m1 has no .guguext attachment')
    await expect(extensionAttachmentOf(context, 'm1', injected('hello'))).rejects.toThrow('message m1 has no .guguext attachment')
    // #7290 群文件夹里的包,条目已经删了(file_item_id 随删除置空):说清楚、不装。
    const inFolder = '[附件] share-1.0.0.guguext (application/vnd.gugu.extension+zip)\n[Size] 409\n[Kind] file'
    await expect(extensionAttachmentOf(context, 'm1', injected(inFolder)))
      .rejects.toThrow('app_install: the package of message m1 was deleted from the group folder')
  })

  test('#7290 a card in the group folder (or a whisper\'s): the install is handed the message, never a URL — who published it the install reads there', async () => {
    const inFolder = '[附件] share-1.0.0.guguext (application/vnd.gugu.extension+zip)\n[Size] 409\n[Kind] file'
    expect(await extensionAttachmentOf(context, 'm1', injected(inFolder, true, { file_item_id: 'i1', file_version: 2, file_blob_id: null })))
      .toEqual({ message_id: 'm1', reader: AGENT })
    expect(await extensionAttachmentOf(context, 'm1', injected(inFolder, true, { file_item_id: null, file_version: null, file_blob_id: 'b1' })))
      .toEqual({ message_id: 'm1', reader: AGENT })
    // An old card: its message too.
    expect(await extensionAttachmentOf(context, 'm1', injected())).toEqual({ message_id: 'm1', reader: AGENT })
  })
})
