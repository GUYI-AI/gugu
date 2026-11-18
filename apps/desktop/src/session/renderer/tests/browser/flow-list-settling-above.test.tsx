import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useFlowList } from '@/lib/flowList'
import '@renderer/index.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

// A message above the viewport reaches its real height late (a code block highlighted in idle time, an image that
// loads near the viewport, a row skipped by content-visibility and laid out again on the way back). Native scroll
// anchoring keeps what the reader is looking at in place; nothing moved the end away from them.
let root: Root, host: HTMLDivElement
let grow: (id: string, height: number) => void = () => {}
let append: () => void = () => {}
function Scene() {
  const [rows, setRows] = useState(() => Array.from({ length: 40 }, (_, i) => `r${i}`))
  const [heights, setHeights] = useState<Record<string, number>>({})
  grow = (id, height) => setHeights((previous) => ({ ...previous, [id]: height }))
  append = () => setRows((previous) => [...previous, `r${previous.length}`])
  const scrollerRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const { start, end } = useFlowList({ scrollerRef, contentRef, resetKey: 'fixture', rowIds: rows, landing: { index: 'LAST', align: 'end' }, followTail: true, atBottomThreshold: 80 })
  return (
    <div ref={scrollerRef} data-flow-view="" style={{ height: 300, width: 400, overflowY: 'auto', overflowAnchor: 'auto' }}>
      <div ref={contentRef}>{rows.slice(start, end).map((id, offset) => (
        <div key={id} data-row={id} aria-posinset={start + offset + 1} style={{ height: heights[id] ?? 100 }}>{id}</div>
      ))}</div>
    </div>
  )
}
const view = () => host.querySelector<HTMLElement>('[data-flow-view]')!
const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`)
const gap = () => view().scrollHeight - view().clientHeight - view().scrollTop
const y = (id: string) => row(id)!.getBoundingClientRect().top - view().getBoundingClientRect().top
const frames = async (count = 4) => { for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }
beforeEach(async () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<Scene />))
  await until('landed at the end', () => Boolean(row('r39')) && gap() < 1)
  // The reader has scrolled around (rows above the viewport are mounted), comes back, scrolls up 40px from the end and rests there.
  await until('rows mounted above', () => { view().scrollTop = 0; return host.querySelectorAll('[data-row]').length >= 15 })
  view().scrollTop = view().scrollHeight
  await frames()
  // The reader scrolls up 40px from the end and rests there.
  view().scrollTop -= 40
  await frames()
})
afterEach(() => { root.unmount(); host.remove() })

it('a reader resting inside the follow threshold stays put when a message above the viewport reaches its real height', async () => {
  const above = [...host.querySelectorAll<HTMLElement>('[data-row]')].find((element) => element.getBoundingClientRect().bottom <= view().getBoundingClientRect().top)!
  const reading = y('r38')
  await act(async () => grow(above.dataset.row!, 300))
  await frames()
  expect(gap(), 'not written back to the end').toBeCloseTo(40, 0)
  expect(y('r38'), 'the message being read does not move').toBeCloseTo(reading, 0)
})

it('five messages above the reader reach their real heights in turn: never written to the end, the message being read never moves', async () => {
  const above = [...host.querySelectorAll<HTMLElement>('[data-row]')].filter((element) => element.getBoundingClientRect().bottom <= view().getBoundingClientRect().top).slice(-5)
  expect(above).toHaveLength(5)
  const reading = y('r38'), samples: Array<{ gap: number; y: number }> = []
  let sampling = true
  const sample = () => { if (!sampling) return; samples.push({ gap: gap(), y: y('r38') }); requestAnimationFrame(sample) }
  requestAnimationFrame(sample)
  for (const element of above.reverse()) {
    await act(async () => grow(element.dataset.row!, 300))
    await frames()
  }
  sampling = false
  expect(Math.min(...samples.map((frame) => frame.gap)), 'no frame was written to the end').toBeGreaterThan(30)
  expect(Math.max(...samples.map((frame) => Math.abs(frame.y - reading))), 'the message being read never moved').toBeLessThan(1)
})

it('a reader resting inside the follow threshold is still followed when a new message arrives', async () => {
  await act(async () => append())
  await until('pinned to the new last message', () => Boolean(row('r40')) && gap() < 1)
})
