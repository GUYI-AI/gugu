import { platform } from '@/platform'
import { chatDb } from './supabase'
import { noteBackendRequestFailed, subscribeBackendRecovered } from '@gugu/core/cloud/backendReachability'
import { rendererLogger } from './log'

declare const brand: unique symbol
/** 云端会话的消息序号(chat.messages.seq,主线与话题共用一个计数)。 */
export type ChatSeq = number & { readonly [brand]: 'ChatSeq' }
/** 本机会话时间线里一条可读气泡的 item id;由宿主 journal 换成 native key,❌ 与 ChatSeq 混用。 */
export type NativeItemId = string & { readonly [brand]: 'NativeItemId' }

export function chatSeq(value: number): ChatSeq {
  if (!Number.isInteger(value) || value < 0) throw new Error(`chat seq must be a non-negative integer, got ${value}`)
  return value as ChatSeq
}

export function nativeItemId(value: string): NativeItemId {
  return value as NativeItemId
}

/**
 * 「已读」写到哪里。云端两种流同一个 RPC(mark_stream_read:主线与 mark_read 同一条 UPDATE,话题写流读位);
 * 本机会话写宿主 journal(桌面与手机共用)。
 */
export type ReadTarget =
  | { kind: 'main'; chatId: string; seq: ChatSeq }
  | { kind: 'thread'; chatId: string; rootId: string; seq: ChatSeq }
  | { kind: 'native'; deviceId: string | null; conversationId: string; itemIds: readonly NativeItemId[] }
  /** 发给你的一条消息你看到了:发送方那边的逐条已读(chat.message_deliveries),与读位是两件事。 */
  | { kind: 'receipt'; chatId: string; messageId: string; readerUserId: string }

/** 云端一条流的读位:没有话题根就是主线。 */
export function cloudReadTarget(chatId: string, rootId: string | null, seq: number): ReadTarget {
  return rootId ? { kind: 'thread', chatId, rootId, seq: chatSeq(seq) } : { kind: 'main', chatId, seq: chatSeq(seq) }
}

async function nativeReadApi(deviceId: string | null) {
  return platform.kind === 'electron'
    ? (await import('@/session/renderer/lib/ipc')).rpcOn(deviceId).sessionTimeline
    : (await import('@/mobile/agent-watch/sessionpage-rpc')).machineRpc(deviceId!).sessionTimeline
}

/** Capture the actual host journal once per opening, rather than trusting a cached session-list count. */
export async function readOwnerNotificationSnapshot(deviceId: string | null, conversationId: string): Promise<readonly NativeItemId[] | undefined> {
  const state: { ownerNotificationUnreadKeys?: string[] } = await (await nativeReadApi(deviceId)).sessionReadState({ conversationId })
  return state.ownerNotificationUnreadKeys?.map(nativeItemId)
}

/**
 * 已读的**唯一写入口**。服务端读位单调只增,这里不守卫:守卫(陈旧 seq 不发)归调用方(advanceReadWatermark)。
 * 失败一律抛;云端的已读写不上时本地读位不回滚(它就是事实),记下这条流,后端恢复时推上去(见下)。
 */
export async function writeRead(target: ReadTarget): Promise<void> {
  try {
    await sendRead(target)
  } catch (error) {
    if (target.kind !== 'native') keepUnconfirmed(target)
    throw error
  }
}

// @@@read-reconcile — 本地读位是事实,服务端的读位落后于它时,在后端恢复那一刻(backendReachability 的那条边)
// 把它推上去:和发件箱的失败行同一条恢复路,❌ 回滚本地、❌ 另起定时器。推不上(后端又断了)就留着等下一次恢复,
// 直到服务端和本地一致 —— 服务端单调只增,多推一次无害。
// 上界:每条流只留最高的那个读位,回执按消息记(只有后端断着时看到的那几条);按账号:换号 / 登出时
// 由账号节拍的主人清掉(forgetUnconfirmedReads),上一个号的读位 ❌ 用下一个号的身份写出去。
const unconfirmed = new Map<string, Exclude<ReadTarget, { kind: 'native' }>>()
let stopReconcile: (() => void) | null = null
const readLog = rendererLogger('chat/read-writer')

function readKey(target: Exclude<ReadTarget, { kind: 'native' }>): string {
  return target.kind === 'receipt' ? `receipt:${target.messageId}:${target.readerUserId}`
    : target.kind === 'thread' ? `thread:${target.chatId}:${target.rootId}` : `main:${target.chatId}`
}

function keepUnconfirmed(target: Exclude<ReadTarget, { kind: 'native' }>): void {
  const key = readKey(target)
  const kept = unconfirmed.get(key)
  if (!(kept && 'seq' in kept && 'seq' in target && kept.seq >= target.seq)) unconfirmed.set(key, target)
  stopReconcile ??= subscribeBackendRecovered(reconcileReads)
  noteBackendRequestFailed()
}

function reconcileReads(): void {
  const due = [...unconfirmed.entries()]
  unconfirmed.clear()
  for (const [key, read] of due) {
    void sendRead(read).catch((error) => {
      // Still not written: it waits for the next recovery, unless a newer read of the stream or a new account replaced it.
      if (!unconfirmed.has(key) && stopReconcile) unconfirmed.set(key, read)
      readLog.warn({ error: String(error), kind: read.kind }, 'read not written on recovery; kept for the next one')
    })
  }
}

/** 换号 / 登出:上一个号没推上去的读位作废(它的本地库也随号作废)。 */
export function forgetUnconfirmedReads(): void {
  unconfirmed.clear()
  stopReconcile?.()
  stopReconcile = null
}

async function sendRead(target: ReadTarget): Promise<void> {
  switch (target.kind) {
    case 'main':
      return markCloudStreamRead(target.chatId, `main:${target.chatId}`, target.seq, null)
    case 'thread':
      return markCloudStreamRead(target.chatId, `thread:${target.chatId}:${target.rootId}`, target.seq, target.rootId)
    case 'native': {
      const api = await nativeReadApi(target.deviceId)
      await api.sessionVisible({ conversationId: target.conversationId, itemIds: [...target.itemIds] })
      return
    }
    case 'receipt': {
      // 服务端对「消息还看不到」是 no-op,不抛;抛出来的都是真错误。
      const { error } = await chatDb.rpc('mark_message_read', { p_chat_id: target.chatId, p_message_id: target.messageId, p_agent_user_id: target.readerUserId })
      if (error) throw new Error(error.message)
      return
    }
  }
}

async function markCloudStreamRead(chatId: string, streamId: string, seq: ChatSeq, threadRootId: string | null): Promise<void> {
  const { data, error } = await chatDb.rpc('mark_stream_read', {
    p_chat_id: chatId,
    p_stream_id: streamId,
    p_seq: seq,
    p_thread_root_id: threadRootId,
  })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (!row || row.stream_id !== streamId) throw new Error(`mark_stream_read returned no state for ${streamId}`)
}
