// MCP surface review 11-16: what the agent reads back is cut to what it acts on — a search hit as the stretch around it,
// a page of messages under one tool output's byte budget, a session without the host's bookkeeping.
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { SEARCH_SNIPPET_CHARS, searchSnippet, withinOutputBudget } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { TOOL_OUTPUT_BYTE_BUDGET } from '../../../../apps/desktop/electron/mcp/mcp-tool-description-budget.mjs'
import { presentSession } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'

describe('message_search hits', () => {
  it('a short hit stays whole; a long one is the stretch around the first matching word, marked truncated', () => {
    expect(searchSnippet({ id: 'm', content: 'short' }, 'short')).toEqual({ id: 'm', content: 'short' })
    const content = `${'a'.repeat(1000)} NEEDLE ${'b'.repeat(1000)}`
    const hit = searchSnippet({ id: 'm', seq: 3, content }, 'needle')
    expect(hit.truncated).toBe(true)
    expect(hit.seq).toBe(3)
    expect(hit.content).toContain('NEEDLE')
    expect(hit.content.length).toBeLessThanOrEqual(SEARCH_SNIPPET_CHARS + 2)
    expect(hit.content.startsWith('…')).toBe(true)
    expect(hit.content.endsWith('…')).toBe(true)
  })
})

describe('message rows under one output budget', () => {
  const row = (seq: number, size: number) => ({ id: `m${seq}`, seq, content: 'x'.repeat(size) })
  it('keeps every row when they fit, and the newest rows (never none) when they do not', () => {
    const small = [row(1, 10), row(2, 10)]
    expect(withinOutputBudget(small)).toBe(small)
    const big = [row(5, 3000), row(4, 3000), row(3, 3000), row(2, 3000)]
    const kept = withinOutputBudget(big)
    expect(kept.map((r: { seq: number }) => r.seq)).toEqual([5, 4])
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(TOOL_OUTPUT_BYTE_BUDGET)
    // Oldest first in, the same newest rows out, in the order given.
    expect(withinOutputBudget([...big].reverse()).map((r: { seq: number }) => r.seq)).toEqual([4, 5])
    expect(withinOutputBudget([row(1, 20_000), row(0, 10)]).map((r: { seq: number }) => r.seq)).toEqual([1])
  })
})

describe('a session as session_get / session_children show it', () => {
  it('keeps what an agent acts on and drops the host bookkeeping, default flags and activity versions', () => {
    const shown = presentSession({
      session_id: 'session:s1', status: 'working', pinned: false,
      runtime: { sessionId: 's1', lifecycle: 'working', rateLimit: { status: 'allowed' }, recentActions: ['Bash'], pendingPermissionCount: 0,
        lastTurnError: null, contextTokens: 1200, contextSize: 200000, transcriptPath: '/t.jsonl', updatedAt: 1 },
      preview: { activityVersion: 1, entries: [{ kind: 'text', text: 'hi', activityVersion: 1 }] },
    })
    expect(shown).toEqual({
      session_id: 'session:s1', status: 'working',
      runtime: { lifecycle: 'working', contextTokens: 1200, contextSize: 200000, transcriptPath: '/t.jsonl' },
      preview: { entries: [{ kind: 'text', text: 'hi' }] },
    })
    expect(presentSession({ session_id: 'session:s2', pinned: true })).toEqual({ session_id: 'session:s2', pinned: true })
  })
})
