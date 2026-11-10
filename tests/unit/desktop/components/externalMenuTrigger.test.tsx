// @vitest-environment jsdom
// A menu opened from a button React does not own (the Solid transcript rows). It follows the Trigger rule, and it closes
// when its button leaves the DOM: the transcript is virtualized, a recycled row takes the button with it, and a menu
// anchored to a detached element would jump to the corner.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useExternalMenuTrigger } from '../../../../apps/desktop/src/components/ui/externalMenuTrigger'
import { createNode, createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let trigger: ReturnType<typeof useExternalMenuTrigger<string>>
function Host() {
  trigger = useExternalMenuTrigger<string>()
  return null
}
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('useExternalMenuTrigger', () => {
  it('a second press on the same button closes; another button moves the menu; a press on the button is not an outside press', async () => {
    const a = document.body.appendChild(document.createElement('button'))
    const b = document.body.appendChild(document.createElement('button'))
    await harness.render(createNode(Host))
    await act(async () => { trigger.press(a, 'a') })
    expect(trigger.opened?.value).toBe('a')
    await act(async () => { trigger.onOpenChange(false, { reason: 'outside-press', event: new PointerEvent('pointerdown') }) })
    // (the event above has no target inside a: an ordinary outside press closes)
    expect(trigger.opened).toBeNull()
    await act(async () => { trigger.press(a, 'a') })
    const onButton = new PointerEvent('pointerdown', { bubbles: true })
    a.addEventListener('pointerdown', () => { void act(async () => { trigger.onOpenChange(false, { reason: 'outside-press', event: onButton }) }) }, { once: true })
    await act(async () => { a.dispatchEvent(onButton) })
    expect(trigger.opened?.value, 'the button\'s own pointerdown is not an outside press').toBe('a')
    await act(async () => { trigger.press(a, 'a') })
    expect(trigger.opened, 'its click closes it').toBeNull()
    await act(async () => { trigger.press(a, 'a') })
    await act(async () => { trigger.press(b, 'b') })
    expect(trigger.opened?.value).toBe('b')
    a.remove(); b.remove()
  })

  it('closes when its button leaves the DOM (a recycled transcript row)', async () => {
    const row = document.body.appendChild(document.createElement('div'))
    const button = row.appendChild(document.createElement('button'))
    await harness.render(createNode(Host))
    await act(async () => { trigger.press(button, 'file') })
    expect(trigger.opened?.anchor).toBe(button)
    await act(async () => { row.remove(); await Promise.resolve() })
    expect(trigger.opened).toBeNull()
  })
})
