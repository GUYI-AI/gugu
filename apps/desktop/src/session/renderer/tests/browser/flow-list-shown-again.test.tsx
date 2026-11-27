import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useFlowList } from '@/lib/flowList'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'
import '@renderer/index.css'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'

let root: Root, host: HTMLDivElement
const ids = Array.from({ length: 40 }, (_, i) => `r${i}`)
const TEXT = 'A message long enough to wrap onto more lines when the list is narrow than when it is wide. '.repeat(3)
let setAway: (away: boolean) => void = () => {}

function List() {
  const scrollerRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const { start, end } = useFlowList({ scrollerRef, contentRef, resetKey: 'fixture', rowIds: ids, landing: { index: 'LAST', align: 'end' }, followTail: true, atBottomThreshold: 5 })
  return <div ref={scrollerRef} data-flow-view="" style={{ flex: 1, height: 400, overflowY: 'auto', overflowAnchor: 'auto', position: 'relative' }}>
    <div ref={contentRef}>{ids.slice(start, end).map((id, offset) => <div key={id} aria-posinset={start + offset + 1} style={{ padding: 8 }}>{id} {TEXT}</div>)}</div>
  </div>
}

// A chat left for another page: in one commit its retained surface is hidden in place and the column it sits in widens (the
// group's inner column folds away with the group), as when a group is left for the new-task page. Coming back, the surface is
// shown first and the column narrows again in a second commit of the same frame (the inner column comes back with the group).
function Scene() {
  const [away, setAwayState] = useState(false)
  const [wide, setWide] = useState(false)
  setAway = (next) => { setAwayState(next); if (next) setWide(true) }
  useLayoutEffect(() => { if (!away) setWide(false) }, [away])
  return <div style={{ position: 'relative', width: wide ? 700 : 360, height: 400, display: 'flex' }}>
    <div style={away ? RETAINED_SURFACE_HIDDEN_STYLE : { flex: 1, minWidth: 0, display: 'flex' }}>
      <List />
    </div>
  </div>
}
const view = () => host.querySelector<HTMLElement>('[data-flow-view]')!
const gap = () => view().scrollHeight - view().clientHeight - view().scrollTop
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { root.unmount(); host.remove() })

it('takes its end again when shown, after a layout while hidden at a size it never has on screen clamped it', async () => {
  await act(async () => root.render(<Scene />))
  await until('the list lands at its end', () => view().scrollHeight > 1000 && gap() <= 1)
  // The whole window mounted (as a chat read for a while has it): the size can only change by layout, not by rows added.
  await until('every row is mounted', () => { view().scrollTop = 0; return view().querySelectorAll('[aria-posinset]').length === ids.length })
  view().scrollTop = view().scrollHeight
  await untilStable('back at its end', () => view().scrollTop)
  expect(gap()).toBeLessThanOrEqual(1)
  const onScreenHeight = view().scrollHeight

  await act(async () => setAway(true))
  // One layout while hidden (the product's own frame did it; a read does it here): the wider rows are shorter, and the browser
  // clamps the scroll position to the shorter content.
  expect(view().scrollHeight, 'laid out wider while hidden: the rows are shorter').toBeLessThan(onScreenHeight - 100)
  for (let i = 0; i < 3; i++) await frame()

  // Both commits before the next frame (as the product's return is drawn: its first frame already has the column back).
  await act(async () => setAway(false))
  await frame()
  await frame()
  expect(view().scrollHeight, 'back at the size it had on screen: an old observation sees no change').toBe(onScreenHeight)
  expect(gap(), 'at its end again').toBeLessThanOrEqual(1)
})
