import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ExternalHistoryStore } from '../../../../external-import/store'

it('opens persisted history after reopening, deduplicates by owner and source, and pages the transcript', () => {
  const directory = mkdtempSync(join(tmpdir(), 'external-history-'))
  const store = new ExternalHistoryStore(directory)
  const reopened = new ExternalHistoryStore(directory)
  const conversation = {
    sourceId: 'same-source-id',
    title: 'A selected conversation',
    messages: Array.from({ length: 45 }, (_, i) => ({ role: 'user' as const, text: `Line ${i}`, at: null })),
  }
  try {
    const saved = store.import('owner-a', 'chatgpt', conversation)!
    expect(saved).toMatchObject({ title: conversation.title, projectId: null })
    store.close()
    expect(reopened.list('owner-a', 'chatgpt')).toEqual([saved])
    expect(reopened.list('owner-b', 'chatgpt')).toEqual([])
    expect(reopened.read('owner-b', saved.sessionId, 0)).toBeNull()
    const first = reopened.read('owner-a', saved.sessionId, 0)!
    expect(first.messages).toEqual(conversation.messages.slice(0, 40))
    expect(reopened.read('owner-a', saved.sessionId, first.nextOffset!)).toMatchObject({
      messages: conversation.messages.slice(40),
      nextOffset: null,
    })
    expect(reopened.import('owner-a', 'chatgpt', conversation)).toBeNull()
    expect(reopened.import('owner-a', 'cursor', conversation)?.sessionId).not.toBe(saved.sessionId)
    expect(reopened.import('owner-b', 'chatgpt', conversation)?.sessionId).not.toBe(saved.sessionId)
  } finally {
    store.close()
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
