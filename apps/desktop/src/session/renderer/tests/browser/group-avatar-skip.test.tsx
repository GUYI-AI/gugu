import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { GroupAvatarSlot } from '@/components/chat/StickyGroupAvatar'
import '@renderer/index.css'
import '@/styles/tokens.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root, host: HTMLDivElement
let setWidth: (width: number) => void = () => {}
const TEXT = 'A bubble long enough to wrap onto more lines when its column gets narrower than it was. '.repeat(3)

// Groups of two rows; every second row is a group tail with its own avatar layer. Laid-out rows are content-visibility:auto.
function Scene({ rows }: { rows: number }) {
  const [width, setState] = useState(500)
  setWidth = setState
  return <div data-scroller="" style={{ height: 300, width, overflowY: 'auto' }}>
    <div>{Array.from({ length: rows }, (_, index) =>
      <div key={index} data-row={index} role="listitem" data-laid-out="" className="gg-msg-row" style={{ display: 'flex' }}>
        <GroupAvatarSlot wide={false} groupedWithPrev={index % 2 === 1} groupedWithNext={index % 2 === 0}><button>Avatar</button></GroupAvatarSlot>
        <div data-message-bubble-row="" style={{ flex: 1 }}>{TEXT}</div>
      </div>)}</div>
  </div>
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const frames = async (count: number) => { for (let i = 0; i < count; i++) await frame() }
const row = (index: number) => host.querySelector<HTMLElement>(`[data-row="${index}"]`)!
const bubble = (index: number) => row(index).querySelector('[data-message-bubble-row]')!.getBoundingClientRect()
const layer = (index: number) => row(index).querySelector<HTMLElement>('.absolute')!
// What the layer has to be: from the group's first bubble top to the tail's bubble bottom.
const expected = (tail: number) => bubble(tail).bottom - bubble(tail - 1).top

let bubbleReads = 0
const nativeRect = Element.prototype.getBoundingClientRect
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  bubbleReads = 0
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute('data-message-bubble-row')) bubbleReads++
    return nativeRect.call(this)
  }
})
afterEach(() => { Element.prototype.getBoundingClientRect = nativeRect; root.unmount(); host.remove() })

async function readsPerWidthChange(rows: number) {
  await act(async () => root.render(<Scene rows={rows} />))
  // Offscreen rows are skipped (their contents report hidden) before the width changes.
  await until('offscreen rows skipped', () => !row(rows - 1).querySelector('[data-message-bubble-row]')!.checkVisibility({ contentVisibilityAuto: true }))
  await frames(3)
  bubbleReads = 0
  await act(async () => setWidth(320))
  await frames(3)
  return bubbleReads
}

it('reads only the shown group tails when the list width changes, however many rows are mounted', async () => {
  const few = await readsPerWidthChange(20)
  act(() => root.unmount()); root = createRoot(host)
  const many = await readsPerWidthChange(200)
  expect(few).toBeGreaterThan(0)
  expect(many).toBe(few)
})

it('measures a tail that was skipped during the width change when it is scrolled into view', async () => {
  await readsPerWidthChange(200)
  // Shown tails were measured at the new width.
  expect(Number.parseFloat(layer(1).style.height)).toBeCloseTo(expected(1), 0)
  const tail = 151
  row(tail).scrollIntoView({ block: 'center' })
  await until('skipped tail measured on unskip', () => Math.abs(Number.parseFloat(layer(tail).style.height) - expected(tail)) < 1)
})
