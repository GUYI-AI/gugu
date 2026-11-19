import { expect, it, vi } from 'vitest'

it('counts summaries without hydrating or retaining any conversation messages', async () => {
  const getSession = vi.fn(() => { throw new Error('body must not be read during scan') })
  const dispose = vi.fn()
  vi.doMock('cursor-history', () => ({
    getSession,
    createSessionReadContext: () => ({ dispose }),
    listSessionSummaries: async () => ({ data: [
      { id: 'one', title: 'Title', resolutionState: 'resolved', preview: 'body must not cross the process boundary' },
      { id: 'two', title: 'Ambiguous', resolutionState: 'ambiguous' },
    ] }),
    isDatabaseNotFoundError: () => false,
  }))
  try {
    const { scanCursorHistory } = await import('../../../../external-import/cursor')
    expect(await scanCursorHistory(new AbortController().signal)).toEqual({ rows: [{ sourceId: 'one', title: 'Title' }], failed: 1 })
    expect(getSession).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  } finally { vi.doUnmock('cursor-history'); vi.resetModules() }
})

it('propagates database errors instead of reporting a successful empty scan', async () => {
  const dispose = vi.fn()
  vi.doMock('cursor-history', () => ({
    createSessionReadContext: () => ({ dispose }),
    listSessionSummaries: async () => { throw new Error('database damaged') },
    isDatabaseNotFoundError: () => false,
  }))
  try {
    const { scanCursorHistory } = await import('../../../../external-import/cursor')
    await expect(scanCursorHistory(new AbortController().signal)).rejects.toThrow('database damaged')
    expect(dispose).toHaveBeenCalledOnce()
  } finally { vi.doUnmock('cursor-history'); vi.resetModules() }
})

it('hydrates only the requested unimported batch and preserves branch filtering', async () => {
  const getSession = vi.fn(async (id: string) => ({ id, activeBranchMessageIds: ['question', 'answer', 'side'], messages: [
    { id: 'question', role: 'user', content: 'Question', timestamp: '2026-01-01' },
    { id: 'other', role: 'assistant', content: 'Other branch', timestamp: '2026-01-01' },
    { id: 'side', role: 'assistant', content: 'Sidechain', isSidechain: true, timestamp: '2026-01-01' },
    { id: 'answer', role: 'assistant', content: 'Answer', timestamp: '2026-01-01' },
  ] }))
  const dispose = vi.fn()
  vi.doMock('cursor-history', () => ({ getSession, createSessionReadContext: () => ({ dispose }) }))
  try {
    const { importCursorHistoryBatch } = await import('../../../../external-import/cursor')
    const store = { has: vi.fn((_owner, _source, id) => id === 'existing'), import: vi.fn(() => ({ sessionId: 'new', projectId: null, title: 'Title', importedAt: 1 })) }
    const result = await importCursorHistoryBatch({ owner: 'owner', offset: 0, size: 2, selection: {
      rows: ['existing', 'new', 'later'].map(sourceId => ({ sourceId, title: 'Title' })), failed: 1,
    } }, store, new AbortController().signal)
    expect(getSession.mock.calls.map(([id]) => id)).toEqual(['new'])
    expect(store.import.mock.calls[0]).toEqual(['owner', 'cursor', {
      sourceId: 'new', title: 'Title', messages: [
        { role: 'user', text: 'Question', at: Date.parse('2026-01-01') },
        { role: 'assistant', text: 'Answer', at: Date.parse('2026-01-01') },
      ],
    }])
    expect(result).toMatchObject({ alreadyImported: 1, failed: 1, done: 3, total: 4 })
    expect(dispose).toHaveBeenCalledOnce()
  } finally { vi.doUnmock('cursor-history'); vi.resetModules() }
})
