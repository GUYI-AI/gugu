// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

// 资源库详情抽屉:离开资源库(「试试看」开新任务、左栏点「消息」)就收起,回来也不再冒出来(11-07 资源库盘点实测:
// 资源库是 retained 视图,抽屉连同遮罩盖在新任务页上,输入框点不到)。
const nav = vi.hoisted(() => ({ currentView: 'library' }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/layout/navigation-provider', () => ({
  useWorkspaceSlots: () => ({ currentView: nav.currentView }),
}))
const { useLibrarySheetSelection } = await import(
  '../../../../apps/desktop/src/session/renderer/features/settings/components/use-library-sheet-selection'
)

let h: ReturnType<typeof createReactHarness>
let state: ReturnType<typeof useLibrarySheetSelection>
function Probe() {
  state = useLibrarySheetSelection()
  return null
}
beforeEach(() => { nav.currentView = 'library'; h = createReactHarness() })
afterEach(() => h.cleanup())

it('closes the integration sheet when the library is left and keeps it closed on return', async () => {
  await h.render(<Probe />)
  await act(async () => state[1]('enterprise-mail'))
  expect(state[0]).toBe('enterprise-mail')

  nav.currentView = 'new-session'
  await h.render(<Probe />)
  expect(state[0]).toBeNull()

  nav.currentView = 'library'
  await h.render(<Probe />)
  expect(state[0]).toBeNull()
})
