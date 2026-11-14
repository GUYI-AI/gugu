// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { RefreshFailed } from '../../../../apps/desktop/src/components/ui/RefreshFailed'

/** The note a settings page puts next to a value whose latest read failed: said, with a retry. */
let harness = createReactHarness()
afterEach(() => { harness.cleanup(); harness = createReactHarness() })

describe('RefreshFailed', () => {
  it('says the latest read failed and retries on request', async () => {
    const retry = vi.fn()
    await harness.render(createNode(RefreshFailed, { error: new Error('offline'), onRetry: retry }))
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
    await clickElement(harness.container.querySelector('button')!)
    expect(retry).toHaveBeenCalledTimes(1)
  })
  it('draws nothing when the latest read did not fail', async () => {
    await harness.render(createNode(RefreshFailed, { error: null, onRetry: vi.fn() }))
    expect(harness.container.innerHTML).toBe('')
  })
})
