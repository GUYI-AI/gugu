import { describe, expect, it } from 'vitest'
import { memoryIndexHints, parseMemoryNote, readFrontmatter, removeIndexEntry } from '@gugu/core/shared/assistantMemory'

describe('memory text parsing boundaries', () => {
  it('reads index hints for the uppercase Markdown extension accepted by note filenames', () => {
    expect(memoryIndexHints('# 项目\n- [Note](./note.MD)\n').get('note.MD')).toEqual({ title: 'Note', kind: 'project' })
  })
  it('removes the relative index spelling that the hints reader accepts', () => {
    const index = '- [Note](./note.md)\n- [Other](other.md)\n'
    expect(memoryIndexHints(index).has('note.md')).toBe(true)
    expect(removeIndexEntry(index, 'note.md')).toBe('- [Other](other.md)\n')
    expect(removeIndexEntry(index, 'missing.md')).toBe(index)
  })
  it.each(['constructor', '__proto__', 'toString'])('does not turn unknown category %s into a memory kind', (type) => {
    expect(parseMemoryNote('note.md', `---\ntype: ${type}\n---\nBody`).kind).toBe('reference')
  })
  it('retains metadata keys that also exist on Object.prototype', () => {
    const { fields } = readFrontmatter('---\nconstructor: note\n__proto__: own\nconstructor: later\n---\nBody')
    expect(Object.hasOwn(fields, 'constructor')).toBe(true)
    expect(Object.hasOwn(fields, '__proto__')).toBe(true)
    expect(fields.constructor).toBe('note')
    expect(fields.__proto__).toBe('own')
  })
  it('requires a complete closing delimiter and preserves an empty header body', () => {
    expect(readFrontmatter('---\n---\nBody')).toEqual({ fields: {}, body: 'Body' })
    expect(readFrontmatter('---\nname: Note\n---suffix\nBody')).toEqual({
      fields: {}, body: '---\nname: Note\n---suffix\nBody',
    })
    expect(readFrontmatter('---\nname: Note\n---suffix\ntype: user\n---\nBody')).toEqual({
      fields: { name: 'Note', type: 'user' }, body: 'Body',
    })
  })
})
