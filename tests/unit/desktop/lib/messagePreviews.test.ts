// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationLink, widgetLink } from '@gugu/core/shared/ui/guguLink'
import { IN_FILTER_CHUNK } from '@gugu/core/shared/inChunks'

const calls: Array<{ select: string; column: string; ids: string[] }> = []
const rows: Array<{ id: string; chat_id: string; message_id: string; text: string }> = []
let refused = false
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { from: () => ({ select: (select: string) => ({
  in: (column: 'id' | 'message_id', ids: string[]) => {
    calls.push({ select, column, ids })
    const response = { data: rows.filter(row => ids.includes(row[column])), error: refused ? { message: 'Data API unavailable' } : null }
    return { then: (done: (value: typeof response) => unknown) => Promise.resolve(response).then(done), abortSignal() { return this } }
  },
}) }) } }))
const { messagePreviewLines } = await import('../../../../apps/desktop/src/lib/messagePreviews')
const chat = '11111111-1111-4111-8111-111111111111'
const message = '22222222-2222-4222-8222-222222222222'
const input = (source: string) => ({ source, preview: source.slice(0, 100) })
beforeEach(() => { calls.length = 0; rows.length = 0; refused = false })

describe('viewer reference preview projection', () => {
  it('keeps ordinary long replies bounded and performs no reference reads', async () => {
    expect(await messagePreviewLines([{ preview: 'x'.repeat(100), source: null }, input('y'.repeat(8000))]))
      .toEqual(['x'.repeat(100), 'y'.repeat(100)])
    expect(calls).toEqual([])
  })

  it('uses the shared AST before truncation and only receives viewer-readable widget labels', async () => {
    rows.push({ id: 'board', chat_id: chat, message_id: message, text: 'Build results' })
    const sources = [widgetLink('board'), widgetLink('hidden'), conversationLink(chat, message), conversationLink(chat, '33333333-3333-4333-8333-333333333333')]
    expect(await messagePreviewLines(sources.map(input))).toEqual(['[引用] Build results', '[引用]', '[引用] Build results', '[引用消息]'])
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.select === 'id,chat_id,message_id,text')).toBe(true)
    expect(calls.flatMap(call => call.ids)).not.toContain('quoted body')
  })

  it('does not attach a widget label to a message link naming the wrong source chat', async () => {
    rows.push({ id: 'board', chat_id: 'different-chat', message_id: message, text: 'Other chat title' })
    expect(await messagePreviewLines([input(conversationLink(chat, message))])).toEqual(['[引用消息]'])
  })

  it('does not read labels for inline, code or nested links and leaves the fifth block a link', async () => {
    const href = widgetLink('board')
    const nested = [`before ${href}`, `\`${href}\``, `> ${href}`, `- ${href}`]
    expect(await messagePreviewLines(nested.map(input))).toEqual(nested)
    expect(calls).toEqual([])
    const source = Array.from({ length: 5 }, (_, index) => widgetLink(String(index))).join('\n\n')
    expect(await messagePreviewLines([input(source)])).toEqual([`[引用]\n\n[引用]\n\n[引用]\n\n[引用]\n\n${widgetLink('4')}`])
    expect(calls[0]?.ids).toEqual(['0', '1', '2', '3'])
  })

  it('shares the existing IN filter budget across a large preview batch and records every request', async () => {
    const onRead = vi.fn()
    const sources = Array.from({ length: IN_FILTER_CHUNK + 1 }, (_, i) => input(widgetLink('widget-' + i)))
    expect(await messagePreviewLines(sources, undefined, onRead)).toEqual(sources.map(() => '[引用]'))
    expect(calls.map(call => call.ids.length)).toEqual([IN_FILTER_CHUNK, 1])
    expect(onRead).toHaveBeenCalledTimes(2)
  })

  it('falls back to the plain reference line when labels cannot be read, and rejects an aborted account read', async () => {
    refused = true
    expect(await messagePreviewLines([input(widgetLink('board')), { preview: 'plain', source: null }])).toEqual(['[引用]', 'plain'])
    refused = false
    const abort = new AbortController(); abort.abort()
    await expect(messagePreviewLines([input(widgetLink('board'))], abort.signal)).rejects.toThrow()
  })
})
