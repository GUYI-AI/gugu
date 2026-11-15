import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { useFlowList, type FlowListHandle, type ListLanding } from '@/lib/flowList'
import { GroupAvatarSlot } from '@/components/chat/StickyGroupAvatar'
import '@renderer/index.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root, host: HTMLDivElement
const ids = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`)
function Scene({ landing, rowHeight = 100, jumpAtMount = false }: { landing: ListLanding; rowHeight?: number; jumpAtMount?: boolean }) {
  const [rows, setRows] = useState(ids(120))
  const [prepended, setPrepended] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null), api = useRef<FlowListHandle>(null)
  const { start, end } = useFlowList({ scrollerRef, contentRef, handleRef: api, resetKey: 'fixture', rowIds: rows, landing, followTail: true, atBottomThreshold: 5 })
  // A chat just switched to that is asked for one of its messages asks before its first landing has filled the view.
  useEffect(() => { if (jumpAtMount) api.current!.scrollToIndex({ index: 6, align: 'start' }) }, [jumpAtMount])
  return <>
    <button onClick={() => api.current!.scrollToIndex({ index: rows.indexOf('r6'), align: 'start' })}>Jump six</button>
    <button onClick={() => api.current!.autoscrollToBottom()}>Latest</button>
    <button onClick={() => { setPrepended(true); setRows(previous => [...Array.from({ length: 4 }, (_, i) => `old${i}`), ...previous]) }}>Prepend</button>
    <button onClick={() => setRows(ids(124).slice(4))}>Trim head</button>
    <div ref={scrollerRef} data-flow-view="" tabIndex={0} style={{ height: 300, width: 500, overflowY: 'auto', overflowAnchor: 'auto' }}>
      <div ref={contentRef}>{rows.slice(start, end).map((id, offset) => {
        const index = start + offset
        return <div key={id} data-row={id} role="listitem" aria-posinset={index + 1} style={{ display: 'flex', height: id === 'r0' && !prepended ? 133 : rowHeight }}>
          <GroupAvatarSlot wide={false} groupedWithPrev={index > 0} groupedWithNext={index < rows.length - 1}><button>Avatar</button></GroupAvatarSlot>
          <div data-message-bubble-row="" style={{ flex: 1 }}>{id}</div>
        </div>
      })}</div>
    </div>
  </>
}
const view = () => host.querySelector<HTMLElement>('[data-flow-view]')!
const row = (id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"]`)
const count = () => host.querySelectorAll('[data-row]').length
const y = (id: string) => row(id)!.getBoundingClientRect().top - view().getBoundingClientRect().top
const frames = async (read = () => 0) => {
  const result = [read()]
  for (let i = 0; i < 6; i++) await new Promise<void>(resolve => requestAnimationFrame(() => { result.push(read()); resolve() }))
  return result
}
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { root.unmount(); host.remove() })
async function render(landing: ListLanding) {
  await act(async () => root.render(<Scene landing={landing} />))
  await until('flow rows mounted', () => count() > 0)
}
const click = async (text: string) => userEvent.click([...host.querySelectorAll('button')].find(button => button.textContent === text)!)

it('keeps only the filled slice idle, then grows by real keyboard scrolling without remounting the tail', async () => {
  await render({ index: 'LAST', align: 'end' })
  const tail = row('r119')
  await frames()
  expect(count()).toBe(6)
  expect(y('r119')).toBeCloseTo(200, 0)
  view().focus()
  await userEvent.keyboard('{Home}')
  await until('near-edge growth after native keyboard scroll', () => count() > 6)
  expect(count()).toBeLessThan(120)
  expect(row('r119')).toBe(tail)
  const layer = row('r119')!.querySelector<HTMLElement>('.absolute')!
  await until('continued group layer reaches first mounted row', () => Number.parseFloat(layer.style.height) >= count() * 100 - 1)
})

it('mounts an omitted jump target before positioning it and can return to the real tail', async () => {
  await render({ index: 'LAST', align: 'end' })
  expect(row('r6')).toBeNull()
  await click('Jump six')
  await until('unmounted target placed from real rectangle', () => Boolean(row('r6')) && Math.abs(y('r6')) < 1)
  await click('Latest')
  await until('real last row is aligned', () => Math.abs(y('r119') - 200) < 1)
})

it('places a jump asked while the first landing is still filling the view, and keeps it there', async () => {
  await act(async () => root.render(<Scene landing={{ index: 'LAST', align: 'end' }} rowHeight={20} jumpAtMount />))
  await until('the jump target is placed at the top', () => Boolean(row('r6')) && Math.abs(y('r6')) < 1)
  expect((await frames(() => y('r6'))).every(top => Math.abs(top) < 1)).toBe(true)
})

it('keeps every sampled frame anchored when prepending changes the old first row header height', async () => {
  await render({ index: 0, align: 'start' })
  const before = y('r1')
  expect(before).toBeCloseTo(133, 0)
  await click('Prepend')
  const positions = await frames(() => y('r1'))
  expect(positions.every(top => Math.abs(top - before) < 1)).toBe(true)
  expect(row('old0')).not.toBeNull()
})

it('follows the retained tail through a full data window head trim without mounting the discarded prefix', async () => {
  await render({ index: 'LAST', align: 'end' })
  const kept = row('r114')
  await click('Trim head')
  const positions = await frames(() => y('r123'))
  expect(positions.every(top => Math.abs(top - 200) < 1)).toBe(true)
  expect(row('r114')).toBe(kept)
  expect(row('r4')).toBeNull()
  expect(count()).toBe(10)
})

it('fills before native Select All so the browser includes every loaded row without a viewport jump', async () => {
  await render({ index: 100, align: 'start' })
  const before = y('r100'), kept = row('r100')
  view().focus()
  await userEvent.keyboard('{Control>}a{/Control}')
  expect(count()).toBe(120)
  expect(ids(120).every(id => getSelection()!.containsNode(row(id)!, true))).toBe(true)
  expect(row('r100')).toBe(kept)
  expect(y('r100')).toBeCloseTo(before, 0)
})

it('keeps Select All local to an editor inside the transcript and an input outside it', async () => {
  await render({ index: 'LAST', align: 'end' })
  const inside = document.createElement('input'), outside = document.createElement('input')
  inside.value = outside.value = 'local draft'
  view().append(inside)
  host.append(outside)
  for (const input of [inside, outside]) {
    input.focus()
    await userEvent.keyboard('{Control>}a{/Control}')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(count()).toBe(6)
  }
})
