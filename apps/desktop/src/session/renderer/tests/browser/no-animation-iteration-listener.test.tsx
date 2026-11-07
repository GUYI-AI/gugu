import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import '@/lib/no-animation-iteration-listeners'

// Guards a React upgrade: if React stops marking its root `_reactListening*` before adding listeners, or wires animation
// events another way, the iteration listener is no longer dropped and this fails instead of the idle frames silently
// coming back.
it('a React root still registers animation events through addEventListener, minus the iteration one', async () => {
  const outside = vi.fn()
  document.body.addEventListener('animationiteration', outside)
  const container = document.createElement('div')
  document.body.append(container)
  const iteration = vi.fn()
  const start = vi.fn()
  const root = createRoot(container)
  await act(async () => root.render(<div id="probe" onAnimationIteration={iteration} onAnimationStart={start} />))
  const probe = document.getElementById('probe')!
  probe.dispatchEvent(new AnimationEvent('animationiteration', { bubbles: true }))
  probe.dispatchEvent(new AnimationEvent('animationstart', { bubbles: true }))
  expect(start).toHaveBeenCalledOnce()
  expect(iteration).not.toHaveBeenCalled()
  expect(outside).toHaveBeenCalledOnce() // a non-React listener still hears it
  document.body.removeEventListener('animationiteration', outside)
  await act(async () => root.unmount())
  container.remove()
})
