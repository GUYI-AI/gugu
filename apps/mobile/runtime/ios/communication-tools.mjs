const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }
const chat = { chat_id: { type: 'string', description: 'The chat UUID from the original delivery, or a group number you have looked up.' } }
const definitions = [
  ['profile_whoami', "Reads this local Agent's real identity.", object({})],
  ['message_conversations', 'Reads the chats visible to this Agent.', object({})],
  ['message_rules', "Reads the chat's current group rules; before sending to a group, follow the rules you have read.", object(chat, ['chat_id'])],
  ['message_members', 'Reads the chat members visible to this Agent and their addressable identities.', object(chat, ['chat_id'])],
  ['message_history', "Reads chat or topic messages within this Agent's visibility.", object({ ...chat,
    limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' }, thread_root_id: string }, ['chat_id'])],
  ['message_send', 'Sends the result back to the original chat. Keep the original message as the reply source; in a group, name the recipients explicitly; a whisper stays private. A retry of the same send keeps the same content and target.', object({ ...chat,
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
