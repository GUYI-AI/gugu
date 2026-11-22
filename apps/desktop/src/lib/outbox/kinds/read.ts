import { chatDb } from '../../supabase'
import type { ChatSeq, ReadTarget } from '../../readWriter'
import { ensureKind, outbox, type OutboxKind } from '..'

/** A cloud read position (a stream's) or a per-message read receipt. */
export type CloudRead = Exclude<ReadTarget, { kind: 'native' }>
const READ = 'read'

function readKey(target: CloudRead): string {
  return target.kind === 'receipt' ? `read:receipt:${target.messageId}:${target.readerUserId}`
    : target.kind === 'thread' ? `read:thread:${target.chatId}:${target.rootId}` : `read:main:${target.chatId}`
}

/**
 * One write per stream; the larger seq wins the merge (the server keeps the larger one too, GREATEST). Accepted once on
 * disk: the local read position is the fact, it is never rolled back, and it reaches the server across restarts.
 */
export const readOutboxKind: OutboxKind<CloudRead> = {
  name: READ,
  lane: readKey,
  merge: (previous, next) => 'seq' in previous && 'seq' in next && previous.seq > next.seq ? previous : next,
  async send({ payload: target }) {
    if (target.kind === 'receipt') {
      // 服务端对「消息还看不到」是 no-op,不抛;抛出来的都是真错误。
      const { error } = await chatDb.rpc('mark_message_read', { p_chat_id: target.chatId, p_message_id: target.messageId, p_agent_user_id: target.readerUserId })
      if (error) throw new Error(error.message)
      return
    }
    const streamId = target.kind === 'thread' ? `thread:${target.chatId}:${target.rootId}` : `main:${target.chatId}`
    await markStreamRead(target.chatId, streamId, target.seq, target.kind === 'thread' ? target.rootId : null)
  },
}

/** Durable once enqueued; `answered`: also wait for the server's first answer (rejects if it failed; the write keeps retrying). */
export async function enqueueRead(target: CloudRead, answered = false): Promise<void> {
  const box = outbox()
  ensureKind(box, readOutboxKind)
  const item = await box.enqueue(READ, target, { id: readKey(target) })
  if (answered) await box.answered(item.id)
}

async function markStreamRead(chatId: string, streamId: string, seq: ChatSeq, threadRootId: string | null): Promise<void> {
  const { data, error } = await chatDb.rpc('mark_stream_read', { p_chat_id: chatId, p_stream_id: streamId, p_seq: seq, p_thread_root_id: threadRootId })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row || row.stream_id !== streamId) throw new Error(`mark_stream_read returned no state for ${streamId}`)
}
