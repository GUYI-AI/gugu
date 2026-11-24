// @@@route-switch-history — 换计费路时带过去的那份对话:源线程的历史(Responses 条目),去掉**封在旧路账号里**的东西。
//
// 为什么不用 `thread/fork`:fork 把历史原样带过去,包括旧路上游发的 `reasoning` 条目(`encrypted_content`)和服务端
// 条目 id。用户自己的 OpenAI 账号解不开咕咕平台那边的加密推理,实测(codex 0.169,真 OpenAI)换路后每一轮都回
// 400 `invalid_encrypted_content`「The encrypted content for item rs_… could not be verified. Reason: Encrypted content
// could not be decrypted or parsed.」—— 会话又卡死。反方向能过只是因为平台网关那条渠道恰好会剪掉推理条目。
// ⇒ 换路时在新路上开一条新线程,把这份去掉封存内容的历史 `thread/inject_items` 进去(同一个 agent,❌ 不补交接)。
//
// 去掉的:带 `encrypted_content` 的条目(推理、压缩摘要 —— 只有旧路账号解得开)、条目自己的 `id`(服务端 id,换个上游
// 就不认识)、开发者消息与每条线程自己的开场上下文(文件里第一个 `turn_context` 之前的条目:那是**那条线程**的,
// 新线程起的时候会给自己的一份)。留下的:人说的、agent 说的、工具调用与工具结果。实测这份历史与 fork 给模型的
// 上下文一样(要复述之前一条 shell 命令的输出,两边都答对),两边上游都收。
//
// 源线程可能本身就是分叉出来的:历史跟着 `session_meta.forked_from_id` 往上找,父线程只取分叉那一刻之前的
// (`forked_from_ordinal_exclusive`,父文件的行序号)。
//
// 压缩过的线程(rollout 里的 `compacted` 行):从那一刻起,codex 发给模型的对话就是它的 `replacement_history`,
// 照这个来 —— ❌ 退回压缩前的原文(那正是被压缩掉的长度,换路后第一轮就可能撑爆窗口)。替换历史里:人说过的话
// 保留(按条目 id 认:它们就是之前那几条);摘要两种形态,实测(0.169):
//  · 平台路(本地压缩)—— 明文摘要,在 `compacted.message`(替换历史里同样一条)⇒ 带过去;
//  · 用户自己的 OpenAI(远端压缩)—— 只有一个加密的 `compaction` 条目,别的账号解不开 ⇒ 带不过去。
// 带不过去时 ❌ 静默丢:返回 `sealedSummaryDropped`,调用方告诉 agent 也告诉人。
import { readAllLines } from '../../../../packages/core/src/local/jsonl.mjs'

/**
 * @param {(method: string, params: unknown) => Promise<any>} rpc 这台 app-server 的请求(失败即抛)
 * @param {string} threadId 源线程
 * @returns {Promise<{ items: object[], sealedSummaryDropped: boolean }>} `items` 可直接交给 `thread/inject_items`
 */
export async function routeSwitchHistory(rpc, threadId) {
  let read
  try {
    read = await rpc('thread/read', { threadId })
  } catch (error) {
    // 从没起过一轮的线程没有存档,`thread/read` 只说「not loaded」。让 `thread/fork` 用它对缺存档的那句标准说法
    // 报出来,宿主的「没聊过」规则认的是那一句(provider-session.ts);它若居然成功,原样报读失败。
    await rpc('thread/fork', { threadId, ephemeral: true })
    throw error
  }
  const history = await historyFromRollout(rpc, read.thread.path, Infinity)
  const items = history.entries.map(({ item }) => item)
  // 带不过去的那份摘要,先告诉 agent(放在最前:它读到的第一句就是「往前的不全」),人那边由调用方说。
  if (history.sealedSummaryDropped) items.unshift(ROUTE_SWITCH_SUMMARY_NOTE)
  return { items, sealedSummaryDropped: history.sealedSummaryDropped }
}

const ROUTE_SWITCH_SUMMARY_NOTE = {
  type: 'message',
  role: 'developer',
  content: [{
    type: 'input_text',
    text: 'This conversation has moved to a different model billing route. Earlier turns had been compacted into a '
      + 'summary that only the previous route can read, so that summary was not carried over: the person\'s own '
      + 'messages from before that point are kept, your replies and tool results from then are not. If you need '
      + 'something from before that point, ask the person instead of guessing.',
  }],
}

/** 摘要没带过去时给人看的那一行(调用方在会话里报出来)。 */
export const ROUTE_SWITCH_SUMMARY_NOTICE = 'Switched billing route. Earlier context had been compacted into a summary '
  + 'that only the previous route can read, so it was not carried over; your messages from before that point were.'

/** 一份对话:每条带着它在 rollout 里的条目 id(压缩时按它认「之前那几条」),交出去之前才去掉。 */
async function historyFromRollout(rpc, path, limit) {
  const lines = await readRollout(path, limit)
  const meta = lines[0]?.type === 'session_meta' ? lines[0].payload : {}
  const inherited = meta.forked_from_id
    ? await historyFromRollout(
      rpc,
      (await rpc('thread/read', { threadId: meta.forked_from_id })).thread.path,
      meta.forked_from_ordinal_exclusive ?? Infinity,
    )
    : { entries: [], sealedSummaryDropped: false }
  let entries = inherited.entries
  let sealedSummaryDropped = inherited.sealedSummaryDropped
  let inTurns = false
  for (const line of lines) {
    if (line.type === 'turn_context') inTurns = true
    if (line.type === 'compacted') {
      const said = new Set(entries.map((entry) => entry.id).filter(Boolean))
      const replacement = line.payload?.replacement_history ?? []
      entries = replacement.filter((item) => item.id && said.has(item.id)).map(conversationEntry).filter(Boolean)
      if (replacement.some((item) => item.encrypted_content)) sealedSummaryDropped = true
      const summary = typeof line.payload?.message === 'string' ? line.payload.message : ''
      if (summary) entries.push({ id: null, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: summary }] } })
      continue
    }
    if (line.type !== 'response_item' || !inTurns) continue
    const entry = conversationEntry(line.payload)
    if (entry) entries.push(entry)
  }
  return { entries, sealedSummaryDropped }
}

function conversationEntry(payload) {
  const { id, ...item } = payload
  if (item.encrypted_content || item.role === 'developer' || item.type === 'additional_tools') return null
  return { id: id ?? null, item }
}

/** 逐行读 rollout 的前 `limit` 条：rollout 可以超过 V8 单个字符串的上限（约 512 MiB），不整份读成一个字符串。 */
async function readRollout(path, limit) {
  const lines = []
  if (limit <= 0) return lines
  for await (const line of readAllLines(path)) {
    if (!line) continue
    lines.push(JSON.parse(line))
    if (lines.length >= limit) break
  }
  return lines
}
