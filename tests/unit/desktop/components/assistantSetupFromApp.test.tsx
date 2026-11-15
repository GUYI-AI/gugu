// @vitest-environment jsdom
// verify-pass1 D5: the assistant App draws its own intro, and its 开通 asks the host for the `setup` screen — now the setup guide
// drawn over the App's panel (the host layer `assistant-setup`; nothing of the assistant is in Settings, owner 11-12). The guide
// used to start at its own intro too, so the person saw the same intro twice. The layer leaves the one-shot hand-off (which
// opening does is app-host-layer.test.tsx / assistantSettingsInApp.test.tsx), and the guide it draws lands on the next real
// step (the name), and only that once. The hand-off and the real setup flow's first step are real here; only the heavy
// children of the steps are stand-ins.
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
// The setup layer's page (AssistantSetupPage) as the shell draws it over the App's panel: who is signed in and that there is no
// assistant yet are fixtures; the guide it draws is the real one (OnboardingSlot's props as the shell passes them).
const who = vi.hoisted(() => ({ owner: '11000000-0000-4000-8000-000000000001', mine: { loading: false, agentId: null, error: null } as Record<string, unknown> }))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: who.owner } }) }))
vi.mock('@/lib/useAssistantHome', () => ({ useAssistantHome: () => ({ mine: who.mine, contact: null }) }))
vi.mock('@/components/assistant/AssistantShellHost', async () => {
  const { AssistantOnboarding: Guide } = await import('@/components/assistant/AssistantOnboarding')
  return { OnboardingSlot: () => createElement(Guide, { ownerUserId: who.owner, ownerName: 'Ann', snapshot: null, device: null, cloudAvailable: false, localDeviceId: 'local' }) }
})
vi.mock('@/components/settings/AssistantSection', () => ({ AssistantSection: () => null }))
vi.mock('@/components/settings/ConnectorsSection', () => ({ ConnectorsSection: () => null }))
vi.mock('@/components/devices/AssistantDevicesPage', () => ({ AssistantDevicesPage: () => null }))
vi.mock('@/components/agentsettings/AgentAiModelPane', () => ({ AgentAiModelPane: () => null }))
vi.mock('@/lib/assistantEntry', () => ({ openAssistantEntry: vi.fn() }))

const { AssistantOnboarding } = await import('@/components/assistant/AssistantOnboarding')
const { AssistantSetupPage } = await import('@/components/assistant/AssistantSettingsPage')
const { clearAssistantOnboardingNavigation } = await import('@/lib/assistantOnboardingNavigation')
const { requestAssistantSetupAfterIntro, takeAssistantStartAtHome } = await import('@/lib/firstRun')
const { installAssistantShellBridge, publishAssistantShell } = await import('@/lib/assistantShellBridge')

const OWNER = '11000000-0000-4000-8000-000000000001'
const OTHER = '22000000-0000-4000-8000-000000000002'

const shell = (over: Record<string, unknown> = {}) => publishAssistantShell({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null, assistant: null, assistantState: 'none', ownerName: 'Ann',
  ownerId: OWNER, chatId: null, home: null, setup: 'shell', member: null, preparing: false, ...over,
} as never)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  sessionStorage.clear()
  clearAssistantOnboardingNavigation(OWNER); clearAssistantOnboardingNavigation(OTHER)
  installAssistantShellBridge()
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  shell({ ownerId: null })
})

/** What the setup layer over the App's panel draws while there is no assistant: the setup flow, mounted fresh each time it opens. */
const setupPage = (owner = OWNER) => harness.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssistantOnboarding, {
  ownerUserId: owner, ownerName: 'Ann', snapshot: null, device: null, cloudAvailable: false, localDeviceId: 'local',
})))
const seen = (id: string) => harness.container.querySelector(`[data-testid="${id}"]`) !== null

describe('the setup layer over the App\'s panel (AssistantSetupPage)', () => {
  const layerPage = () => harness.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssistantSetupPage)))

  it('draws the guide from the name: the App\'s intro under it was the first screen; each opening the same', async () => {
    shell()
    who.mine = { loading: false, agentId: null, error: null }
    await layerPage()
    expect(seen('name-step')).toBe(true)
    expect(seen('intro')).toBe(false)
    expect(takeAssistantStartAtHome(OWNER)).toBe(false)
    harness.cleanup(); harness = createReactHarness()
    await layerPage()
    expect(seen('name-step')).toBe(true)
  })

  it('still finding who it is, or unable to: says so, no guide, and no hand-off left for another way in', async () => {
    for (const mine of [{ loading: true, agentId: null, error: null }, { loading: false, agentId: 'a1', error: null }, { loading: false, agentId: null, error: 'boom' }]) {
      who.mine = mine
      await layerPage()
      expect(seen('assistant-setup-page')).toBe(true)
      expect(seen('name-step') || seen('intro')).toBe(false)
      expect(takeAssistantStartAtHome(OWNER)).toBe(false)
      harness.cleanup(); harness = createReactHarness()
    }
    who.mine = { loading: false, agentId: null, error: null }
  })
})

describe('开通 inside the assistant App', () => {
  it('the setup the App\'s 开通 opens starts at the name, not at a second copy of the intro the person just left', async () => {
    shell()
    requestAssistantSetupAfterIntro(OWNER)
    await setupPage()
    expect(seen('name-step')).toBe(true)
    expect(seen('intro')).toBe(false)
  })

  it('is one click: the hand-off is taken by the setup that opens, so the next opening starts at its intro again', async () => {
    shell()
    requestAssistantSetupAfterIntro(OWNER)
    await setupPage()
    expect(seen('name-step')).toBe(true)
    expect(takeAssistantStartAtHome(OWNER)).toBe(false)
    harness.cleanup(); harness = createReactHarness()
    await setupPage()
    expect(seen('intro')).toBe(true)
  })

  it('is about this account only', async () => {
    shell()
    requestAssistantSetupAfterIntro(OWNER)
    await setupPage(OTHER)
    expect(seen('intro')).toBe(true)
    expect(takeAssistantStartAtHome(OWNER)).toBe(true)
  })

  it('opened any other way it starts at the intro; only the App intro\'s hand-off starts it at the name', async () => {
    shell()
    await setupPage()
    expect(seen('intro')).toBe(true)
    harness.cleanup(); harness = createReactHarness()
    requestAssistantSetupAfterIntro(OWNER)
    await setupPage()
    expect(seen('name-step')).toBe(true)
  })
})
