import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { ExternalConversation, ExternalMessage } from '../../src/session/shared/core/session-import/external-conversation-import'

const MAX_FILE_BYTES = 128 * 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function visibleMessage(value: unknown): ExternalMessage | undefined {
  const message = record(value)
  const role = record(message?.author)?.role
  if (role !== 'user' && role !== 'assistant') return
  if (record(message?.metadata)?.is_visually_hidden_from_conversation === true) return
  if (message?.recipient && message.recipient !== 'all') return
  const content = record(message?.content)
  if (content?.content_type !== 'text' && content?.content_type !== 'multimodal_text') return
  if (!Array.isArray(content.parts)) return
  const text = content.parts.filter((part): part is string => typeof part === 'string').join('\n')
  if (!text.trim()) return
  const seconds = message?.create_time
  const at = typeof seconds === 'number' && Number.isFinite(seconds) && Math.abs(seconds) <= 8.64e12 ? seconds * 1000 : null
  return { role, text, at }
}

export function readChatGptConversation(value: unknown): ExternalConversation | null {
  const conversation = record(value)
  const mapping = record(conversation?.mapping)
  const sourceId = nonempty(conversation?.id) ?? nonempty(conversation?.conversation_id)
  const currentNode = nonempty(conversation?.current_node)
  if (!mapping || !sourceId || !currentNode) return null

  const messages: ExternalMessage[] = []
  const visited = new Set<string>()
  let nodeId: string | undefined = currentNode
  while (nodeId) {
    if (visited.has(nodeId) || !Object.hasOwn(mapping, nodeId)) return null
    visited.add(nodeId)
    const node = record(mapping[nodeId])
    if (!node) return null
    const message = visibleMessage(node.message)
    if (message) messages.push(message)
    if (node.parent != null && !nonempty(node.parent)) return null
    nodeId = nonempty(node.parent)
  }
  if (!messages.length) return null
  messages.reverse()
  return { sourceId, title: nonempty(conversation?.title) ?? messages[0].text.trim().slice(0, 120), messages }
}

export async function readChatGptExport(path: string): Promise<unknown[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stats = await file.stat()
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new Error('unsupported_export_size')
    const buffer = Buffer.alloc(stats.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== stats.size) throw new Error('export_changed')
    const contents: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8').replace(/^\uFEFF/, ''))
    if (!Array.isArray(contents)) throw new Error('invalid_export')
    return contents
  } finally {
    await file.close()
  }
}
