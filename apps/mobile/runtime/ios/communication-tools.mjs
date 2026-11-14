const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const chat = { chat_id: { type: 'string', description: '原投递的聊天 UUID 或已查到的群号。' } }
const definitions = [
  ['profile_whoami', '读取当前本机 Agent 的真实身份。', object({})],
  ['message_conversations', '读取当前 Agent 可见的聊天。', object({})],
  ['message_rules', '读取聊天当前群规，向群聊发送前须遵守已读群规。', object(chat, ['chat_id'])],
  ['message_members', '读取当前 Agent 可见的聊天成员及可寻址身份。', object(chat, ['chat_id'])],
  ['message_history', '按当前 Agent 的可见域读取聊天或话题消息。', object({ ...chat,
    limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' }, thread_root_id: string }, ['chat_id'])],
  ['message_send', '把结果发回原聊天。保留原消息作为 reply source；群聊须明确收件人，悄悄话保留私密性。同次重试保留相同内容和目标。', object({ ...chat,
    text: string, to_user_ids: { type: 'array', items: string }, reply_to_message_id: string, whisper: { type: 'boolean' },
  }, ['chat_id', 'text'])],
]
export const communicationToolNames = Object.freeze(definitions.map(([name]) => name))

/** Descriptions and schemas carry no native credentials or selected identity. */
export function communicationTools(invoke) {
  return definitions.map(([name, description, parameters]) => ({ name, description, parameters,
    execute: async (toolCallId, args, signal) => {
      let result
      try { result = await invoke(name, args, toolCallId, signal) }
      catch (error) { result = { ok: false, code: error.code ?? 'communication_failed', message: error.message } }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, ...(result.ok === true ? {} : { isError: true }) }
    },
  }))
}
