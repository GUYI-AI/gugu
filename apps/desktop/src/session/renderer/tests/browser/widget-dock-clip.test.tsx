import { afterEach, expect, it } from 'vitest'
import { clippedElementBox } from '@/lib/elementVisibility'

let column: HTMLElement
afterEach(() => column?.remove())

// What the composer's cards cover is not seen: a widget slot's visible box (the presence that picks its live slot, the
// resident layer's pages) is cut there, as the message list behind them is.
it('cuts a slot at the top of its conversation\'s composer card, and only in that column', () => {
  column = document.createElement('div')
  column.setAttribute('data-chat-dock-column', 'c')
  column.innerHTML = `<div style="position:fixed;top:0;left:0;width:400px;height:600px;overflow:auto">
      <div style="height:400px"></div><div id="slot" style="height:200px"></div></div>
    <div data-chat-bottom-dock="" style="position:fixed;left:0;top:450px;width:400px">
      <div style="height:30px"></div><div style="height:120px"></div></div>`
  document.body.append(column)
  const slot = column.querySelector<HTMLElement>('#slot')!
  const bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 400, width: 400, height: 80 })
  column.removeAttribute('data-chat-dock-column')
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 400, width: 400, height: 200 })
})

// A task timeline sticks a turn's user summary to the top of its scroller: a widget scrolled under its bubble is cut there
// too. Only the bubble is drawn, so beside it nothing is cut.
it('cuts a slot below a stuck summary bubble, and not while it sits lower, is not drawn stuck, or is beside the slot', () => {
  column = document.createElement('div')
  column.innerHTML = `<div id="scroller" data-chat-scroll style="position:fixed;top:0;left:0;width:400px;height:600px;overflow:auto;scrollbar-width:none">
      <div id="row" data-pin-stuck="true"><div style="position:sticky;top:0;height:60px"><div data-pin-summary="m" style="margin-left:auto;width:200px;height:52px"></div></div>
      <div style="height:100px"></div><div id="slot" style="height:200px"></div><div style="height:1000px"></div></div></div>`
  document.body.append(column)
  const slot = column.querySelector<HTMLElement>('#slot')!
  const bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 160, width: 400, height: 200 })
  column.querySelector('#scroller')!.scrollTop = 130
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 52, width: 400, height: 178 })
  // Beside the bubble: the rows show there, so the slot is not cut.
  slot.style.width = '150px'
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 30, width: 150, height: 200 })
  slot.style.width = ''
  // At the top by geometry but not drawn yet (a question still on screen keeps its summary hidden): nothing covers the slot.
  column.querySelector('#row')!.setAttribute('data-pin-stuck', 'false')
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 30, width: 400, height: 200 })
})
