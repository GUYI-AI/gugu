// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../../../../../../../../tests/support/testHarness'
import { ChangesListOrTree } from './changes-list-or-tree'
import { ChangesViewModeToggle } from './changes-view-mode-toggle'

vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

/** The changes layout is a device setting: until it is read, the toggle and the list hold their places, ❌ draw "flat". */
describe('changes layout not read yet', () => {
  it('the toggle is a placeholder, not a button that would switch away from a layout nobody chose', async () => {
    const harness = createReactHarness()
    await harness.render(createElement(ChangesViewModeToggle, { value: null, onChange: () => {}, label: 'Changed' }))
    expect(harness.container.querySelector('[data-unknown]')).not.toBeNull()
    expect(harness.container.querySelector('button')).toBeNull()
    harness.cleanup()
  })

  it('the list draws one row-high placeholder per change, no layout chosen', async () => {
    const harness = createReactHarness()
    const changes = [{ path: 'a.ts' }, { path: 'b.ts' }] as never
    await harness.render(createElement(ChangesListOrTree, { viewMode: null, changes }))
    expect(harness.container.querySelectorAll('[data-unknown]')).toHaveLength(2)
    harness.cleanup()
  })
})
