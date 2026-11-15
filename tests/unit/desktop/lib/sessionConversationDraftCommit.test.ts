import { expect, it, vi } from 'vitest'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { createDraftWriter } from '../../../../apps/desktop/src/store/chatDraftWrites'

it('reads the current document for a task handoff, before the persisted draft catches up', () => {
  const drafts = { topic: 'older snapshot', other: 'other topic' }
  const writer = createDraftWriter(() => ({ drafts, setDraft: vi.fn() }))
  let live = 'older snapshot'
  const editor = { getText: () => live, setText: (text: string) => { live = text } } as unknown as PromptEditorRef
  const unregister = writer.registerDraftEditor('topic', () => editor)
  live = 'latest @[person](user:person-id)'
  expect(writer.readDraft('topic')).toBe(live)
  expect(writer.readDraft('other')).toBe('other topic')
  live = ''
  expect(writer.readDraft('topic')).toBe('')
  unregister()
  expect(writer.readDraft('topic')).toBe('older snapshot')
})

it.each(['Hi', 'Hi again', 'Hi appended', ''])('only consumes a complete unchanged live draft (%j)', text => {
  const drafts: Record<string, string> = { task: 'Hi' }
  const setDraft = (key: string, update: (current: string) => string) => { drafts[key] = update(drafts[key] ?? '') }
  const writer = createDraftWriter(() => ({ drafts, setDraft }))
  let live = 'Hi'
  const setText = vi.fn((next: string) => { live = next })
  const editor = { getText: () => live, setText } as unknown as PromptEditorRef
  writer.registerDraftEditor('task', () => editor)
  live = text
  setText.mockClear()
  writer.writeDraft('task', { clearIf: 'Hi' })
  expect(live).toBe(text === 'Hi' ? '' : text)
  expect(setText).toHaveBeenCalledTimes(text === 'Hi' ? 1 : 0)
})

it('settles a closed slot without touching a different task or a newer draft', () => {
  const drafts: Record<string, string> = { task: 'Hi', other: 'other words' }
  const writer = createDraftWriter(() => ({ drafts, setDraft: (key, update) => { drafts[key] = update(drafts[key] ?? '') } }))
  writer.writeDraft('task', { clearIf: 'Hi' })
  expect(drafts).toEqual({ task: '', other: 'other words' })
  drafts.task = 'Hi again'
  writer.writeDraft('task', { clearIf: 'Hi' })
  expect(drafts.task).toBe('Hi again')
})
