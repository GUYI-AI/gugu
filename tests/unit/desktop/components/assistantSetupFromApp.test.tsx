// @vitest-environment jsdom
// verify-pass1 D5: the assistant App draws its own intro, and its 开通 asks the host for the `setup` screen (Settings' 咕咕 page).
// Settings' setup used to start at its own intro too, so the person saw the same intro twice. Now the click lands on the next real
// step (the name), and only that: any other way into Settings' setup still starts at the intro. The App's click, the one-shot
// hand-off and the real setup flow's first step are all real here; only the heavy children of the steps are stand-ins.
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('@/components/agentAvatar/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('@/components/assistant/AssistantIntro', () => ({ AssistantIntro: () => createElement('p', { 'data-testid': 'intro' }) }))
vi.mock('@/components/assistant/AssistantSetupIdentity', () => ({ AssistantSetupIdentity: () => createElement('p', { 'data-testid': 'name-step' }) }))
vi.mock('@/components/assistant/AssistantServerSetup', () => ({ AssistantServerSetup: () => null }))
vi.mock('@/lib/assistantServerSetup', () => ({ pendingServerAssistant: () => null }))
vi.mock('@/lib/assistantSetup', () => ({
  ASSISTANT_NAME_MAX: 30, draftAvatarUrl: () => '', pendingLocalAssistant: () => null,
  resumeLocalAssistant: vi.fn(), setUpAssistantOnThisComputer: vi.fn(), claimCloudAssistant: vi.fn(), AssistantSetupError: class extends Error {},
}))
// The hand-off itself (sessionStorage) is the real one; only the account read it also holds is replaced.
vi.mock('@/lib/firstRun', async (original) => ({ ...(await original<object>()), readOccupation: async () => null }))
vi.mock('@/lib/assistantSetupState', () => ({ offerCustomizeCard: vi.fn(), writeSetupStep: vi.fn() }))
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn(), isMyAssistant: () => false }))
vi.mock('@/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn() }))
vi.mock('@gugu/core/cloud/optionalServices', () => ({ cloudComputerEnabled: () => false }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))

const { AssistantOnboarding } = await import('@/components/assistant/AssistantOnboarding')
const { clearAssistantOnboardingNavigation } = await import('@/lib/assistantOnboardingNavigation')
const { openAssistantScreen } = await import('@/lib/assistantAppHost')
const { requestAssistantSetupAfterIntro, takeAssistantStartAtHome } = await import('@/lib/firstRun')
const { installAssistantShellBridge, publishAssistantShell } = await import('@/lib/assistantShellBridge')
const { UI_EVENTS } = await import('@/lib/uiEvents')

const OWNER = '11000000-0000-4000-8000-000000000001'
const OTHER = '22000000-0000-4000-8000-000000000002'

const shell = (over: Record<string, unknown> = {}) => publishAssistantShell({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null, assistant: null, assistantState: 'none', ownerName: 'Ann',
  ownerId: OWNER, chatId: null, home: null, setup: 'shell', member: null, preparing: false, ...over,
} as never)

const settings: unknown[] = []
const onSettings = (event: Event) => settings.push((event as CustomEvent).detail)
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  sessionStorage.clear()
  clearAssistantOnboardingNavigation(OWNER); clearAssistantOnboardingNavigation(OTHER)
  installAssistantShellBridge()
  settings.length = 0
  window.addEventListener(UI_EVENTS.openSettings, onSettings)
  harness = createReactHarness()
})
afterEach(() => {
  window.removeEventListener(UI_EVENTS.openSettings, onSettings)
  harness.cleanup()
  shell({ ownerId: null })
})

/** What Settings' 咕咕 page draws while there is no assistant: the setup flow, mounted fresh each time the page opens. */
const settingsSetupPage = (owner = OWNER) => harness.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssistantOnboarding, {
  ownerUserId: owner, ownerName: 'Ann', snapshot: null, device: null, cloudAvailable: false, localDeviceId: 'local',
})))
const seen = (id: string) => harness.container.querySelector(`[data-testid="${id}"]`) !== null

describe('开通 inside the assistant App', () => {
  it('opens Settings\' 咕咕 setup at the name, not at a second copy of the intro the person just left', async () => {
    shell()
    openAssistantScreen('setup', OWNER)
    expect(settings).toEqual([{ section: 'assistant' }])
    await settingsSetupPage()
    expect(seen('name-step')).toBe(true)
    expect(seen('intro')).toBe(false)
  })

  it('is one click: the hand-off is taken by the setup that opens, so the next opening of the page starts at its intro again', async () => {
    shell()
    openAssistantScreen('setup', OWNER)
    await settingsSetupPage()
    expect(seen('name-step')).toBe(true)
    expect(takeAssistantStartAtHome(OWNER)).toBe(false)
    harness.cleanup(); harness = createReactHarness()
    await settingsSetupPage()
    expect(seen('intro')).toBe(true)
  })

  it('is about this account only', async () => {
    shell()
    openAssistantScreen('setup', OWNER)
    await settingsSetupPage(OTHER)
    expect(seen('intro')).toBe(true)
    expect(takeAssistantStartAtHome(OWNER)).toBe(true)
  })

  it.each([
    ['an assistant already there (the page does not draw the setup at all)', 'setup', { assistantState: 'found' }],
    ['the assistant still being read', 'setup', { assistantState: 'loading' }],
    ['moving it, not setting it up', 'move', {}],
  ] as const)('leaves no hand-off lying around for %s', (_why, screen, over) => {
    shell(over)
    openAssistantScreen(screen, OWNER)
    expect(settings).toEqual([{ section: 'assistant' }])
    expect(takeAssistantStartAtHome(OWNER)).toBe(false)
  })

  it('the other ways into Settings\' setup are not changed: opened by itself it starts at the intro, the hand-off at the name', async () => {
    shell()
    await settingsSetupPage()
    expect(seen('intro')).toBe(true)
    harness.cleanup(); harness = createReactHarness()
    requestAssistantSetupAfterIntro(OWNER)
    await settingsSetupPage()
    expect(seen('name-step')).toBe(true)
  })
})
