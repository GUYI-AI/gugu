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

it('reads memory frontmatter inline comments', () => {
  const note = parseMemoryNote(
    'note.md',
    '---\nname: "Plan #1" # label\ntype: project # category\ndescription: see https://example.test/#part\n---\nBody'
  )
  expect(note.title).toBe('Plan #1')
  expect(note.kind).toBe('project')
  expect(note.description).toBe('see https://example.test/#part')
  expect(readFrontmatter("---\nname: 'Ada''s # plan' # note\n---\nBody").fields.name).toBe(
    "Ada's # plan"
  )
})

it('decodes quoted memory metadata escapes', () => {
  expect(
    readFrontmatter('---\nname: "Plan\\u0020A"\ndescription: "line\\nnext\\tstep"\n---\nBody')
      .fields
  ).toEqual({ name: 'Plan A', description: 'line\nnext\tstep' })
})

it('ignores fenced headings in memory titles', () => {
  expect(parseMemoryNote('note.md', '~~~md\n# Example\n~~~\n# Actual title').title).toBe(
    'Actual title'
  )
  expect(
    parseMemoryNote('note.md', '````md\n# Example\n```\n# Still example\n````\n## Actual').title
  ).toBe('Actual')
})

it('reads memory index links with titles', () => {
  expect(memoryIndexHints('# 项目\n- [Plan](./plan.md "Details")').get('plan.md')).toEqual({
    title: 'Plan',
    kind: 'project'
  })
  expect(memoryIndexHints("[Plan](plan.md 'Details')").has('plan.md')).toBe(true)
})

it('reads angle memory index destinations', () => {
  expect(memoryIndexHints('[Plan](<./my plan.md> "Details")').get('my plan.md')).toEqual({
    title: 'Plan'
  })
  expect(memoryIndexHints('[Other](<nested/note.md>)').size).toBe(0)
})

it('decodes memory index filenames once', () => {
  expect(memoryIndexHints('[茶](tea%20notes.md)').get('tea notes.md')).toEqual({ title: '茶' })
  expect(memoryIndexHints('[Literal](literal%2520.md)').has('literal%20.md')).toBe(true)
  expect(memoryIndexHints('[Nested](nested%2Fnote.md)').size).toBe(0)
  expect(memoryIndexHints('[Bad](bad%ZZ.md)').size).toBe(0)
})

it('ignores memory index code examples', () => {
  const hints = memoryIndexHints(
    '# 项目\n~~~md\n# 用户\n[Fake](fake.md)\n~~~\n- [Real](real.md)\nExample: `[Inline](inline.md)`'
  )
  expect([...hints.keys()]).toEqual(['real.md'])
  expect(hints.get('real.md')?.kind).toBe('project')
})

it('removes parsed memory index entries', () => {
  const index =
    '~~~md\n[Example](tea%20notes.md)\n~~~\n- [Tea](<./tea notes.md> "Details")\n- [Other](other.md)\n'
  expect(removeIndexEntry(index, 'tea notes.md')).toBe(
    '~~~md\n[Example](tea%20notes.md)\n~~~\n- [Other](other.md)\n'
  )
  expect(removeIndexEntry('Example: `[Tea](tea.md)`\n- [Tea](tea.md "Details")', 'tea.md')).toBe(
    'Example: `[Tea](tea.md)`'
  )
})
