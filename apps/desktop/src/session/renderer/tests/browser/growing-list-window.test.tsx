/**
 * @@@growing-list — a list whose length grows with the user's data mounts the lines around its visible part, whatever its
 * length: the @ candidates of a 400-member group, a member page with sections in one scroller. Counted in Chromium, where
 * the lines have real heights.
 */
import { ComboboxPopup, type ComboboxPopupHandle, type ComboboxPopupItem } from '@gugu/session-ui/react/primitives'
import { GrowingList } from '@gugu/session-ui/react/growing-list'
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

let root: Root | null = null
let container: HTMLDivElement | null = null
function mountHost(): Root {
  container = document.createElement('div')
  container.className = 'emlight gugu-skin bg-background'
  document.body.appendChild(container)
  root = createRoot(container)
  return root
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const candidates = (count: number): ComboboxPopupItem[] => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, label: `Member ${i}` }))
const highlighted = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')

it('400 @ candidates mount the window around the view, and the keyboard keeps the highlighted one in it', async () => {
  const ref = createRef<ComboboxPopupHandle>()
  const r = mountHost()
  act(() => r.render(<ComboboxPopup ref={ref} items={candidates(400)} anchorRect={new DOMRect(100, 100, 10, 20)} onSelect={() => {}} />))
  await until('the popup is up', () => highlighted()?.textContent?.includes('Member 0') === true)
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(40)

  for (let i = 0; i < 120; i++) act(() => void ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
  await until('Member 120 is highlighted', () => highlighted()?.textContent?.includes('Member 120') === true)
  const scroller = document.querySelector<HTMLElement>('[role="listbox"] [data-growing-list]')!
  await until('it is inside the popup\'s view', () => {
    const box = highlighted()!.getBoundingClientRect(), view = scroller.getBoundingClientRect()
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
  })
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(40)
})

it('sections sharing one scroller each mount only their part in view, and scrolling brings the next one in', async () => {
  function Panel() {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    return (
      <div ref={setScroller} data-testid="scroller" style={{ height: 400, overflowY: 'auto' }}>
        {(['people', 'agents'] as const).map((section) => (
          <section key={section} data-section={section}>
            <h3 style={{ height: 30, margin: 0 }}>{section}</h3>
            <GrowingList scroller={scroller} count={400} getKey={(i) => i} estimateSize={() => 40}
              renderLine={(i) => <div data-line={`${section}-${i}`} style={{ height: 40 }}>{section} {i}</div>} />
          </section>
        ))}
      </div>
    )
  }
  act(() => mountHost().render(<Panel />))
  await until('people lines are drawn', () => document.querySelector('[data-line="people-0"]') != null)
  expect(document.querySelectorAll('[data-line^="people-"]').length).toBeLessThan(40)
  // A list below the view still mounts its first few lines (the window always starts somewhere): far fewer than 400.
  expect(document.querySelectorAll('[data-line^="agents-"]').length).toBeLessThan(20)

  const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!
  // The agents section starts below 400 people lines (16 030 px): scroll to it.
  act(() => { scroller.scrollTop = 30 + 400 * 40 + 30 })
  await until('agent 0 is drawn where its section starts', () => {
    const line = document.querySelector<HTMLElement>('[data-line="agents-0"]')
    return line != null && Math.abs(line.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 2
  })
  expect(document.querySelectorAll('[data-line^="agents-"]').length).toBeLessThan(40)
  expect(document.querySelectorAll('[data-line^="people-"]').length).toBeLessThan(20)
})
