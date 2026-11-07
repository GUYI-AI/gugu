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
