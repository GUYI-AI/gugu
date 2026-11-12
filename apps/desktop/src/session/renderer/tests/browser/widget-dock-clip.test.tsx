import { afterEach, expect, it } from 'vitest'
import { clippedElementBox } from '@/lib/elementVisibility'

let column: HTMLElement
afterEach(() => column?.remove())

// The resident layer draws a widget's page above the whole window, so what the composer's cards cover must be cut
// from its box, as the message list behind them is.
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

// A task timeline sticks a turn's user summary to the top of its scroller: a widget scrolled under it is cut there too.
it('cuts a slot below a pin stuck to the top of its scroller, and not while the pin sits lower or is not drawn stuck', () => {
  column = document.createElement('div')
  column.innerHTML = `<div id="scroller" style="position:fixed;top:0;left:0;width:400px;height:600px;overflow:auto;scrollbar-width:none">
      <div id="row" data-pin-stuck="true"><div style="position:sticky;top:0;height:60px"><div data-chat-pin-backdrop="" style="position:absolute;inset:0"></div></div>
      <div style="height:100px"></div><div id="slot" style="height:200px"></div><div style="height:1000px"></div></div></div>`
  document.body.append(column)
  const slot = column.querySelector<HTMLElement>('#slot')!
  const bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight }
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 160, width: 400, height: 200 })
  column.querySelector('#scroller')!.scrollTop = 130
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 60, width: 400, height: 170 })
  // At the top by geometry but not drawn yet (a question still on screen keeps its summary hidden): nothing covers the slot.
  column.querySelector('#row')!.setAttribute('data-pin-stuck', 'false')
  expect(clippedElementBox(slot, bounds).clip).toEqual({ left: 0, top: 30, width: 400, height: 200 })
})
