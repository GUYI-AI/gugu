// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../support/testHarness'
import { requestPhoneAgentCreation, usePhoneAgentCreation } from '../../../apps/desktop/src/mobile/agent-watch/phone-agent-creation'
import { UI_EVENTS } from '../../../apps/desktop/src/lib/uiEvents'

let ui: ReturnType<typeof createReactHarness>
function Host({ onCreate, mobile = true }: { onCreate: () => void; mobile?: boolean }) {
  usePhoneAgentCreation(onCreate, mobile)
  return null
}
beforeEach(() => { ui = createReactHarness() })
afterEach(() => ui.cleanup())

it('a generic phone entry uses the existing creation owner without creating anything on mount', async () => {
  const create = vi.fn()
  await ui.render(<Host onCreate={create} />)
  expect(create).not.toHaveBeenCalled()
  requestPhoneAgentCreation()
  expect(create).toHaveBeenCalledOnce()
})

it('group and project entries retain their birth context instead of opening generic creation', async () => {
  const create = vi.fn(), scoped = vi.fn()
  await ui.render(<Host onCreate={create} />)
  window.addEventListener(UI_EVENTS.createAgentInGroup, scoped)
  try {
    requestPhoneAgentCreation('project-group')
    expect((scoped.mock.calls[0]![0] as CustomEvent).detail).toEqual({ chatId: 'project-group' })
    expect(create).not.toHaveBeenCalled()
  } finally { window.removeEventListener(UI_EVENTS.createAgentInGroup, scoped) }
})

it('the phone shortcut has no listener on desktop and removes its listener on exit', async () => {
  const create = vi.fn()
  await ui.render(<Host onCreate={create} mobile={false} />)
  requestPhoneAgentCreation()
  expect(create).not.toHaveBeenCalled()
  await ui.render(<Host onCreate={create} />)
  await ui.render(null)
  requestPhoneAgentCreation()
  expect(create).not.toHaveBeenCalled()
})
