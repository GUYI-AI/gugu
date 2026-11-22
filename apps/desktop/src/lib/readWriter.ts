import { platform } from '@/platform'
import { enqueueRead } from './outbox/kinds/read'

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
    : (await import('@/components/session-watch/sessionpage-rpc')).machineRpc(deviceId!).sessionTimeline
}

/** Capture the actual host journal once per opening, rather than trusting a cached session-list count. */
export async function readOwnerNotificationSnapshot(deviceId: string | null, conversationId: string): Promise<readonly NativeItemId[] | undefined> {
  const state: { ownerNotificationUnreadKeys?: string[] } = await (await nativeReadApi(deviceId)).sessionReadState({ conversationId })
  return state.ownerNotificationUnreadKeys?.map(nativeItemId)
}

/**
 * 已读的**唯一写入口**。服务端读位单调只增,这里不守卫:守卫(陈旧 seq 不发)归调用方(advanceReadWatermark)。
 * 云端的读位进发件箱(kind `read`,id 按流):落盘即受理,写不上时本地读位不回滚(它就是事实),跨重启接着推;
 * 同一条流只留最高的那个读位(入队合并)。本机会话的读写宿主 journal,失败照抛。
 */
export async function writeRead(target: ReadTarget, options: { answered?: boolean } = {}): Promise<void> {
  if (target.kind === 'native') {
    const api = await nativeReadApi(target.deviceId)
    await api.sessionVisible({ conversationId: target.conversationId, itemIds: [...target.itemIds] })
    return
  }
  await enqueueRead(target, options.answered)
}
