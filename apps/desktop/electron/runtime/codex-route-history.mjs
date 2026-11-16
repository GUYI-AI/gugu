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
import { readFileSync } from 'node:fs'

/**
 * @param {(method: string, params: unknown) => Promise<any>} rpc 这台 app-server 的请求(失败即抛)
 * @param {string} threadId 源线程
 * @returns {Promise<object[]>} 可直接交给 `thread/inject_items` 的条目
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
  return historyFromRollout(rpc, read.thread.path, Infinity)
}

async function historyFromRollout(rpc, path, limit) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(0, limit).map((line) => JSON.parse(line))
  const meta = lines[0]?.type === 'session_meta' ? lines[0].payload : {}
  const inherited = meta.forked_from_id
    ? await historyFromRollout(
      rpc,
      (await rpc('thread/read', { threadId: meta.forked_from_id })).thread.path,
      meta.forked_from_ordinal_exclusive ?? Infinity,
    )
    : []
  const own = []
  let inTurns = false
  for (const line of lines) {
    if (line.type === 'turn_context') inTurns = true
    if (line.type !== 'response_item' || !inTurns) continue
    const { id: _serverId, ...item } = line.payload
    if (item.encrypted_content || item.role === 'developer' || item.type === 'additional_tools') continue
    own.push(item)
  }
  return [...inherited, ...own]
}
