// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

import { SurfaceShown } from '../../../../apps/desktop/src/lib/retainedSurface'
const { useLibrarySheetSelection } = await import(
  '../../../../apps/desktop/src/session/renderer/features/settings/components/use-library-sheet-selection'
)

let h: ReturnType<typeof createReactHarness>
let state: ReturnType<typeof useLibrarySheetSelection>
function Probe() {
  state = useLibrarySheetSelection()
  return null
}
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())

it('closes the integration sheet when the marketplace is hidden and keeps it closed on return', async () => {
  await h.render(<SurfaceShown shown><Probe /></SurfaceShown>)
  await act(async () => state[1]('enterprise-mail'))
  expect(state[0]).toBe('enterprise-mail')

  await h.render(<SurfaceShown shown={false}><Probe /></SurfaceShown>)
  expect(state[0]).toBeNull()

  await h.render(<SurfaceShown shown><Probe /></SurfaceShown>)
  expect(state[0]).toBeNull()
})
