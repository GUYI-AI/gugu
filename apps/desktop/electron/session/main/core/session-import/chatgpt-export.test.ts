import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readChatGptConversation, readChatGptExport } from '../../../../external-import/chatgpt'

const message = (role: string, ...parts: unknown[]) => ({
  author: { role },
  recipient: 'all',
  content: { content_type: 'text', parts },
})

const thread = {
  conversation_id: 'one',
  title: 'An imported conversation',
  current_node: 'tip',
  mapping: {
    root: { parent: null, message: null },
    user: { parent: 'root', message: { ...message('user', 'Question'), create_time: 5 } },
    other: { parent: 'user', message: message('assistant', 'Discarded answer') },
    tool: { parent: 'user', message: { ...message('assistant', 'Tool call'), recipient: 'browser' } },
    hidden: { parent: 'tool', message: { ...message('assistant', 'Private'), metadata: { is_visually_hidden_from_conversation: true } } },
    tip: { parent: 'hidden', message: message('assistant', 'Answer', { asset_pointer: 'opaque' }, 'More') },
  },
}

describe('ChatGPT conversation export', () => {
  it('reads the selected branch and preserves visible user and assistant text', () => {
    expect(readChatGptConversation(thread)).toEqual({
      sourceId: 'one',
      title: 'An imported conversation',
      messages: [
        { role: 'user', text: 'Question', at: 5000 },
        { role: 'assistant', text: 'Answer\nMore', at: null },
      ],
    })
  })

  it('rejects dangling parents or cycles instead of displaying a partial branch', () => {
    expect(readChatGptConversation({ ...thread, current_node: 'missing' })).toBeNull()
    expect(readChatGptConversation({
      ...thread,
      mapping: { ...thread.mapping, root: { parent: 'tip' } },
    })).toBeNull()
  })

  it('reads a selected JSON file and rejects unrelated JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatgpt-export-'))
    try {
      const valid = join(root, 'conversations-001.json')
      const other = join(root, 'user.json')
      await writeFile(valid, '\uFEFF' + JSON.stringify([thread]))
      await writeFile(other, JSON.stringify({ user: 'example' }))
      expect(await readChatGptExport(valid)).toEqual([thread])
      await expect(readChatGptExport(other)).rejects.toThrow('invalid_export')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
