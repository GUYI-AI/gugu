import { afterEach, describe, expect, it } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { Chip } from '@/components/ui/Chip'
import '@/styles/tokens.css'

// #2548: news that does not call you is a small grey dot, the counterpart of the red count. The chip's text
// min-height (a box that holds text grows with the phone's font size) must not stretch the textless dot into a pill.
let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  document.documentElement.style.removeProperty('--text-scale')
})

describe('chat row news dot (#2548)', () => {
  it.each(['1', '1.3'])('stays an 8px circle beside the count at text scale %s', async (scale) => {
    document.documentElement.style.setProperty('--text-scale', scale)
    harness = createReactHarness()
    await renderWithAppProviders(harness, <div style={{ display: 'flex', alignItems: 'center' }}>
      <Chip tone="danger" shape="count">3</Chip>
      <Chip shape="dot" role="img" aria-label="news" />
    </div>)
    const dot = harness.container.querySelector<HTMLElement>('[data-shape="dot"]')!
    const box = dot.getBoundingClientRect()
    expect({ width: box.width, height: box.height }).toEqual({ width: 8, height: 8 })
    const count = harness.container.querySelector<HTMLElement>('[data-shape="count"]')!.getBoundingClientRect()
    expect(count.height).toBeCloseTo(18 * Number(scale), 0)
  })
})
