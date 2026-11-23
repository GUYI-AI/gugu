/**
 * @@@row-style-scope guard: a row body is style-contained from the moment it mounts, not only once it becomes skippable.
 * The body turns content-visibility:auto after its first layout (data-laid-out, MessageRow), and content-visibility:auto
 * implies style containment. When that containment was switched on by the style change, Electron's Blink created a quote
 * scope (OrderedScope<LayoutQuote>) for it that it never destroyed: every row that had been laid out left one behind when it
 * unmounted (~36 per opened conversation or viewer). Containment that is already there when the body is created is torn down
 * with it. The leak itself only shows in the app's Chromium (not this test browser's); this pins the precondition.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { MessageRow } from '@/components/chat/MessageRow'
import { ROW_BODY_ATTR } from '@/components/chat/avatarTrack'
import '@renderer/index.css'
import '@/styles/tokens.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

it('a row body is style-contained before and after it becomes skippable', async () => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;overflow:auto'
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MessageRow messageId="m"><p>message</p></MessageRow>))
    const row = host.querySelector<HTMLElement>('.gg-msg-row')!
    const body = row.querySelector<HTMLElement>(`[${ROW_BODY_ATTR}]`)!
    const contains = () => getComputedStyle(body).contain.split(' ')
    // Mounted, not yet laid out: not skippable, but already style-contained.
    expect(row.hasAttribute('data-laid-out')).toBe(false)
    expect(getComputedStyle(body).contentVisibility).toBe('visible')
    expect(contains()).toContain('style')
    await until('the row is marked skippable after its first paint', () => row.hasAttribute('data-laid-out'))
    expect(getComputedStyle(body).contentVisibility).toBe('auto')
    expect(contains()).toContain('style')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
