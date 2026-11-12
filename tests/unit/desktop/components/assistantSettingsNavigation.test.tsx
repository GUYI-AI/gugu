// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../../support/testHarness'
import { AssistantSettingsPage } from '../../../../apps/desktop/src/components/assistant/AssistantSettingsPage'
import { useAssistantPanelBack, useAssistantPanelPage } from '../../../../apps/desktop/src/lib/assistantPanelPage'
import { requestAssistantSettingsSection, takeAssistantSettingsSection } from '../../../../apps/desktop/src/lib/assistantSettingsSection'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('@/lib/useAssistantHome', () => ({ useAssistantHome: () => ({ contact: { id: 'assistant' }, cloudDeviceId: null }) }))
vi.mock('@/session/renderer/lib/stores/app-state', () => ({ appState: {} }))
vi.mock('@/components/agentsettings/AgentAiModelPane', () => ({ AgentAiModelPane: () => <div data-testid="model-pane" /> }))
vi.mock('@/components/settings/AssistantSection', () => ({ AssistantSection: ({ onOpenSection }: { onOpenSection: (id: string) => void }) =>
  <>{['connectors', 'devices'].map(id => <button key={id} data-testid={`open-${id}`} onClick={() => onOpenSection(id)}>{id}</button>)}</> }))
function Section({ panelNavigation = false }: { panelNavigation?: boolean }) {
  const [detail, setDetail] = useState(false)
  useAssistantPanelBack(panelNavigation && detail ? 'detail' : null, () => setDetail(false))
  return detail ? <div data-testid="detail">{!panelNavigation && <button onClick={() => setDetail(false)}>Inner back</button>}</div>
    : <button data-testid="open-detail" onClick={() => setDetail(true)}>Detail</button>
}
vi.mock('@/components/settings/ConnectorsSection', () => ({ ConnectorsSection: (props: { panelNavigation?: boolean }) => <Section {...props} /> }))
vi.mock('@/components/devices/AssistantDevicesPage', () => ({ AssistantDevicesPage: (props: { panelNavigation?: boolean }) => <Section {...props} /> }))

let h: ReturnType<typeof createReactHarness>, toolbar: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); toolbar = createReactHarness() })
afterEach(() => { h.cleanup(); toolbar.cleanup(); requestAssistantSettingsSection(null) })
function Toolbar() { const page = useAssistantPanelPage(); return page ? <button onClick={page.back}>{page.key}</button> : null }
it.each(['connectors', 'devices'])('uses only the toolbar for settings → %s → detail, and returns one level at a time', async section => {
  await toolbar.render(<Toolbar />)
  await h.render(<AssistantSettingsPage panelNavigation />)
  await clickElement(h.container.querySelector(`[data-testid="open-${section}"]`)!)
  expect([...h.container.querySelectorAll('button')].some(button => button.textContent === '返回')).toBe(false)
  expect(toolbar.container.textContent).toBe(`settings:${section}`)
  await clickElement(h.container.querySelector('[data-testid="open-detail"]')!)
  expect(h.container.querySelector('[data-testid="detail"]')).not.toBeNull()
  expect(h.container.querySelector('button')).toBeNull()
  await clickElement(toolbar.container.querySelector('button')!)
  expect(h.container.querySelector('[data-testid="open-detail"]')).not.toBeNull()
  await clickElement(toolbar.container.querySelector('button')!)
  expect(h.container.querySelector(`[data-testid="open-${section}"]`)).not.toBeNull()
})
it('retains the local return control outside the assistant panel', async () => {
  await h.render(<AssistantSettingsPage />)
  await clickElement(h.container.querySelector('[data-testid="open-connectors"]')!)
  const back = [...h.container.querySelectorAll('button')].find(button => button.textContent === '返回')!
  expect(back).toBeDefined()
  await clickElement(back)
  expect(h.container.querySelector('[data-testid="open-connectors"]')).not.toBeNull()
})

// The assistant's dialog is its figure alone (owner 11-12): an entry asking for its model (换模型, the App's open "model") lands on
// this page's model screen, whether the page was already up or is drawn after the ask.
it('opens at the model screen when asked before it is drawn, with the toolbar back to 资料', async () => {
  await toolbar.render(<Toolbar />)
  requestAssistantSettingsSection('aimodel')
  await h.render(<AssistantSettingsPage panelNavigation />)
  expect(h.container.querySelector('[data-testid="model-pane"]')).not.toBeNull()
  expect(toolbar.container.textContent).toBe('settings:aimodel')
  expect(takeAssistantSettingsSection()).toBeNull()
  await clickElement(toolbar.container.querySelector('button')!)
  expect(h.container.querySelector('[data-testid="model-pane"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="open-connectors"]')).not.toBeNull()
})
it('moves to the model screen when asked while 资料 is already up', async () => {
  await h.render(<AssistantSettingsPage panelNavigation />)
  expect(h.container.querySelector('[data-testid="model-pane"]')).toBeNull()
  await act(async () => { requestAssistantSettingsSection('aimodel') })
  expect(h.container.querySelector('[data-testid="model-pane"]')).not.toBeNull()
})
it('leaves the ask for the page over the App panel: the phone-less inline page does not take it', async () => {
  requestAssistantSettingsSection('aimodel')
  await h.render(<AssistantSettingsPage />)
  expect(h.container.querySelector('[data-testid="model-pane"]')).toBeNull()
  expect(takeAssistantSettingsSection()).toBe('aimodel')
})
