// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'

// @@@avatar-retry: a picture that failed is tried again once the network is back or the window is focused, and only then.
describe('avatar retry', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  const img = () => host.querySelector('img')
  const fire = (target: EventTarget, type: string) => act(() => { target.dispatchEvent(new Event(type)) })

  it('fails, comes back on the next online, and once loaded stops listening', () => {
    act(() => root.render(<Avatar name="Liu" isAgent={false} avatarUrl="https://cdn.example.test/u/liu.png" />))
    expect(img()).not.toBeNull()
    fire(img()!, 'error')
    expect(img(), 'a failed picture is not drawn').toBeNull()
    fire(window, 'online')
    expect(img(), 'the network back: the picture is tried again').not.toBeNull()
    fire(img()!, 'load')
    const loaded = img()
    fire(window, 'focus')
    expect(img(), 'a loaded picture is left as it is: no remount, no new request').toBe(loaded)
  })

  it('fails again on the retry and waits for the next event; a focus also retries', () => {
    act(() => root.render(<Avatar name="Liu" isAgent={false} avatarUrl="https://cdn.example.test/u/liu.png" />))
    fire(img()!, 'error')
    fire(window, 'online')
    fire(img()!, 'error')
    expect(img(), 'still failing: no loop of retries').toBeNull()
    fire(window, 'focus')
    expect(img()).not.toBeNull()
  })
})
