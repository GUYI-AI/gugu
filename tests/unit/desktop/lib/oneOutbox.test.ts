/**
 * Guard: the renderer has one outbox. Every write a device asks the server or a session host to make goes through an
 * outbox kind; a new direct call to one of these writes, or a second durable queue beside the outbox, fails here.
 * To add a write, add a kind (apps/desktop/src/lib/outbox/kinds/*) and enqueue into it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../../..')
const SRC = join(ROOT, 'apps/desktop/src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'tests' || name === 'node_modules' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const files = sources(SRC).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))

/** pattern → the only files allowed to contain it. */
const WRITES: { what: string; pattern: RegExp; allowed: string[] }[] = [
  { what: 'a chat message send', pattern: /chatService\.sendMessage\(/, allowed: ['apps/desktop/src/store/chatOutboxWiring.ts'] },
  { what: 'an attachment commit / share / forward', pattern: /(?<![.\w])(commitAttachment|shareAttachment|forwardAttachment|commitPreparedChatAttachment)\(/,
    allowed: ['apps/desktop/src/store/chatOutboxWiring.ts', 'apps/desktop/src/lib/attachmentsEndpoint.ts'] },
  { what: 'a read position or read receipt', pattern: /rpc\(\s*'(mark_stream_read|mark_message_read|mark_read)'/, allowed: ['apps/desktop/src/lib/outbox/kinds/read.ts'] },
  { what: 'a reaction write', pattern: /from\(\s*'message_reactions'\s*\)\s*\.(insert|upsert|delete|update)\(/, allowed: ['apps/desktop/src/lib/outbox/kinds/reaction.ts'] },
  { what: 'a session input handed to its host', pattern: /sessionTimeline\.sessionSend\(\{[^}]*clientMessageId/, allowed: ['apps/desktop/src/hooks/useOutboxHost.tsx', 'apps/desktop/src/components/session-watch/sessionpage-rpc.ts' /* the phone's transport the kind uses */] },
  { what: 'a new topic', pattern: /topicService\.createTopic\(/, allowed: ['apps/desktop/src/store/chatOutboxWiring.ts'] },
  { what: 'an assistant App change notice', pattern: /assistantPanelCloud\.notice\(/, allowed: ['apps/desktop/src/lib/outbox/kinds/assistantNotice.ts'] },
  { what: 'an outbox instance', pattern: /(?<![.\w])createOutbox\(/, allowed: ['apps/desktop/src/lib/outbox/index.ts', 'apps/desktop/src/lib/outbox/core.ts'] },
  { what: 'a durable write queue database', pattern: /open\(\s*'gugu\.[\w.-]*(outbox|queue)[\w.-]*'/i, allowed: ['apps/desktop/src/lib/outbox/storage.ts'] },
]

describe('one outbox', () => {
  for (const write of WRITES) {
    it(`${write.what} goes only through its outbox kind`, () => {
      const offenders = files.filter((file) => write.pattern.test(file.text) && !write.allowed.includes(file.path)).map((file) => file.path)
      expect(offenders).toEqual([])
    })
  }

  it('the removed queues stay removed', () => {
    const removed = ['sessionInputOutbox', 'sessionInputOutboxBridge', 'attachmentSendRecovery', 'assistantPanelOutbox']
    for (const name of removed) {
      expect(files.filter((file) => new RegExp(`/${name}['"]`).test(file.text)).map((file) => file.path), name).toEqual([])
    }
    expect(files.filter((file) => /unconfirmed\s*=\s*new Map/.test(file.text) && file.path.endsWith('readWriter.ts'))).toEqual([])
  })
})
