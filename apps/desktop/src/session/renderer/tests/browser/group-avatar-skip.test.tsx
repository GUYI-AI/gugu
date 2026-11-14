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

// The shape MessageList + MessageBubble give a row: the avatar slot beside the message column, which holds the bubble.
// A laid-out row's message column is content-visibility:auto (tokens.css); the avatar slot is outside it.
// groupSize rows per group; the last row of each group is its tail, with the avatar layer.
function Scene({ rows, groupSize = 2 }: { rows: number; groupSize?: number }) {
  const [width, setState] = useState(500)
  setWidth = setState
  return <div data-scroller="" style={{ height: 300, width, overflowY: 'auto' }}>
    <div>{Array.from({ length: rows }, (_, index) =>
      <div key={index} data-row={index} role="listitem" data-laid-out="" className="gg-msg-row">
        <div style={{ display: 'flex' }}>
          <GroupAvatarSlot wide={false} groupedWithPrev={index % groupSize !== 0} groupedWithNext={index % groupSize !== groupSize - 1}><button>Avatar</button></GroupAvatarSlot>
          <div data-message-bubble-column="" style={{ flex: 1, minWidth: 0 }}><div data-message-bubble-row="">{TEXT}</div></div>
        </div>
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
  // Offscreen message columns are skipped (their contents report hidden) before the width changes.
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

it('paints a group avatar at the bottom of the view while its tail is below it, and hit-tests it there', async () => {
  await act(async () => root.render(<Scene rows={40} groupSize={10} />))
  // Group 1 is rows 10–19. Put row 12 at the top of the view: its tail (row 19) is far below the view.
  const scroller = host.querySelector<HTMLElement>('[data-scroller]')!
  scroller.scrollTop += row(12).getBoundingClientRect().top - scroller.getBoundingClientRect().top
  await until('offscreen rows skipped', () => !row(39).querySelector('[data-message-bubble-row]')!.checkVisibility({ contentVisibilityAuto: true }))
  await frames(3)
  const view = scroller.getBoundingClientRect()
  expect(row(19).getBoundingClientRect().top).toBeGreaterThan(view.bottom)
  const avatar = row(19).querySelector('button')!.getBoundingClientRect()
  // Sticky at the bottom of the view, inside it.
  expect(avatar.bottom).toBeLessThanOrEqual(view.bottom)
  expect(avatar.bottom).toBeGreaterThan(view.bottom - 40)
  // Painted there: the hit test lands on this group's avatar, not on what is under it.
  expect(document.elementFromPoint(avatar.left + avatar.width / 2, avatar.top + avatar.height / 2)).toBe(row(19).querySelector('button'))
})
