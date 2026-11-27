import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useFlowList } from '@/lib/flowList'
import { useRetainedHiddenStyle } from '@/lib/retainedSurface'
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

// The session page's screen, retained under another page: the area it is laid out in widens in the very commit it is hidden
// (leaving a group folds the group's inner column), and narrows again in a second commit of the frame it is shown again in.
function Area() {
  const [away, setAwayState] = useState(false)
  const [wide, setWide] = useState(false)
  setAway = (next) => { setAwayState(next); if (next) setWide(true) }
  useLayoutEffect(() => { if (!away) setWide(false) }, [away])
  const areaRef = useRef<HTMLDivElement>(null)
  const hiddenStyle = useRetainedHiddenStyle(areaRef, !away)
  return <div ref={areaRef} style={{ position: 'relative', width: wide ? 700 : 360, height: 400, display: 'flex', flexDirection: 'column' }}>
    <div style={away ? hiddenStyle : { display: 'contents' }}><List /></div>
  </div>
}
const view = () => host.querySelector<HTMLElement>('[data-flow-view]')!
const gap = () => view().scrollHeight - view().clientHeight - view().scrollTop
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { root.unmount(); host.remove() })

it('a hidden retained surface keeps its width while its area widens, so a list at its end stays there', async () => {
  await act(async () => root.render(<Area />))
  await until('the list lands at its end', () => view().scrollHeight > 1000 && gap() <= 1)
  // The whole window mounted (as a chat read for a while has it): the size can only change by layout, not by rows added.
  await until('every row is mounted', () => { view().scrollTop = 0; return view().querySelectorAll('[aria-posinset]').length === ids.length })
  view().scrollTop = view().scrollHeight
  await untilStable('back at its end', () => view().scrollTop)
  const onScreen = { height: view().scrollHeight, width: view().clientWidth }

  await act(async () => setAway(true))
  // One layout while hidden (the product's own frame does it; a read does it here): at the width it had on screen, unchanged.
  expect(view().clientWidth, 'hidden, it keeps the width it had on screen').toBe(onScreen.width)
  expect(view().scrollHeight, 'so its rows do not reflow').toBe(onScreen.height)
  expect(gap(), 'and the list is still at its end').toBeLessThanOrEqual(1)
  for (let i = 0; i < 3; i++) await frame()

  await act(async () => setAway(false))
  await frame()
  await frame()
  expect(gap(), 'shown again, at its end').toBeLessThanOrEqual(1)
})
