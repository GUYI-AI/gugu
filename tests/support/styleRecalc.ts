import { cdp } from 'vitest/browser'

type TraceEvent = { name: string; ph: string; args?: { elementCount?: number } }
type TraceSession = {
  send(method: string, params?: object): Promise<unknown>
  on(event: string, listener: (payload: { stream?: string }) => void): void
}

// One listener for the page's lifetime; each measurement waits for its own completion.
let finished: ((stream: string | undefined) => void) | null = null
let listening = false

/**
 * How many elements Chromium's style recalculation touched while `action` ran (the trace's
 * `UpdateLayoutTree.elementCount`, summed). The ruler for "this change re-styles what it concerns, not the page":
 * a count does not depend on how fast or busy the machine is, a duration does.
 *
 * Style pending before `action` is flushed first, and the style `action` dirties is flushed before the trace ends, so
 * the count is exactly what `action` cost. Give the page a known number of bystander elements and compare against it.
 *
 * The trace is read back as a stream after it has ended: events pushed to a listener can still be on their way when
 * the completion arrives (seen in CI: zero events, then a count of 0 for a whole-page re-style).
 */
export async function restyledElements(action: () => void | Promise<void>): Promise<number> {
  const session = cdp() as unknown as TraceSession
  if (!listening) {
    listening = true
    session.on('Tracing.tracingComplete', (payload) => { finished?.(payload.stream) })
  }
  const complete = new Promise<string | undefined>((resolve) => { finished = resolve })
  void document.body.offsetWidth
  await session.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['devtools.timeline'], excludedCategories: ['*'] } })
  let handle: string | undefined
  try {
    await action()
    void document.body.offsetWidth
  } finally {
    await session.send('Tracing.end')
    handle = await complete
    finished = null
  }
  if (!handle) throw new Error('the trace ended without a stream to read')
  let text = ''
  for (;;) {
    const chunk = await session.send('IO.read', { handle }) as { data: string; eof: boolean; base64Encoded?: boolean }
    text += chunk.base64Encoded ? atob(chunk.data) : chunk.data
    if (chunk.eof) break
  }
  await session.send('IO.close', { handle })
  const parsed = JSON.parse(text) as TraceEvent[] | { traceEvents: TraceEvent[] }
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  if (events.length === 0) throw new Error('the trace came back empty: nothing was measured')
  return events.filter((event) => event.name === 'UpdateLayoutTree' && event.ph === 'X').reduce((sum, event) => sum + (event.args?.elementCount ?? 0), 0)
}
