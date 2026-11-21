// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { ReadingSlot } from '../../../../apps/desktop/src/components/ui/ReadingSlot'
import { RefreshFailed } from '../../../../apps/desktop/src/components/ui/RefreshFailed'
import type { Reading } from '../../../../apps/desktop/src/lib/replica'

/**
 * @@@reading-slot — the one place a reading's three states are drawn (and `RefreshFailed reading=` for a failed refresh
 * beside a value drawn elsewhere). What every surface relies on, tested once here instead of per surface.
 */
let harness = createReactHarness()
afterEach(() => { harness.cleanup(); harness = createReactHarness() })
const draw = (reading: Reading<string>) => harness.render(createNode(ReadingSlot<string>, {
  reading, placeholder: 'w-24', children: (value: string) => createNode('span', { 'data-value': '' }, value),
}))

describe('ReadingSlot', () => {
  it('not read yet: the placeholder the value\'s size, nothing said', async () => {
    await draw({ state: 'unknown' })
    expect(harness.container.querySelector('[data-unknown]')?.className).toContain('w-24')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('unreadable: the failure said with the reading\'s own retry, ❌ a value', async () => {
    const retry = vi.fn(async () => undefined)
    await draw({ state: 'error', error: new Error('offline'), retry })
    expect(harness.container.querySelector('[data-value]')).toBeNull()
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
    await clickElement(harness.container.querySelector('[role="alert"] button')!)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('read and current: the value, nothing said', async () => {
    await draw({ state: 'value', value: 'Alice', stale: false, error: null, retry: vi.fn() })
    expect(harness.container.querySelector('[data-value]')?.textContent).toBe('Alice')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('read before, its refresh failed: the value stays and the failure is said beside it with the same retry', async () => {
    const retry = vi.fn(async () => undefined)
    await draw({ state: 'value', value: 'Alice', stale: true, error: new Error('offline'), retry })
    expect(harness.container.querySelector('[data-value]')?.textContent).toBe('Alice')
    await clickElement(harness.container.querySelector('[role="alert"] button')!)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('RefreshFailed with a reading', () => {
  it('says a value\'s failed refresh with the reading\'s retry; says nothing for a current value or one not read yet', async () => {
    const retry = vi.fn(async () => undefined)
    await harness.render(createNode(RefreshFailed, { reading: { state: 'value', value: 1, stale: true, error: new Error('offline'), retry } }))
    await clickElement(harness.container.querySelector('button')!)
    expect(retry).toHaveBeenCalledTimes(1)
    await harness.render(createNode(RefreshFailed, { reading: { state: 'value', value: 1, stale: false, error: null, retry } }))
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    await harness.render(createNode(RefreshFailed, { reading: { state: 'unknown' } }))
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })
})
