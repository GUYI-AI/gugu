// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
const io = vi.hoisted(() => ({
  firstRunDoneHere: vi.fn(() => false), rememberFirstRunDone: vi.fn(),
  readFirstRunProgress: vi.fn(async () => ({ stage: 'intro', occupation: { key: 'research' }, harness: null })),
  readOccupation: vi.fn(async () => ({ key: 'research' })),
  writeOccupation: vi.fn(async () => undefined), writeFirstRunHarness: vi.fn(async () => undefined),
  writeFirstRunTerminalSeen: vi.fn(async () => undefined),
  finishFirstRun: vi.fn(async () => '2026-10-28T00:00:00Z'),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => io)
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', () => ({
  startFirstRunHints: vi.fn(async () => undefined), readFirstRunHints: vi.fn(async () => null), dismissFirstRunHints: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => ({ enrollSampleProject: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: {} }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), saveProductTourState: vi.fn(async () => undefined),
}))
const native = vi.hoisted(() => ({ install: vi.fn(), status: vi.fn() }))
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatuses: () => ({ installAsync: native.install }), useAgentInstallProgress: () => null,
}))
vi.mock('@renderer/lib/ipc', () => {
  const rpc = {
    appSettings: {
      getWithMeta: async () => ({ value: { enabled: false, lastPicked: 'codex' }, defaults: {}, overrides: {} }),
      update: async () => undefined,
    },
    agents: { getAgentInstallationStatus: native.status, cancelInstall: vi.fn(), list: async () => [], listAgentInstallationStatus: async () => [] },
  }
  return { rpc, rpcOn: () => rpc, events: { on: () => () => {} }, onMachineEvent: () => () => {} }
})

import { FirstRunGate } from '../../../../apps/desktop/src/components/firstRun/FirstRunGate'
import { i18n } from '../../../../apps/desktop/src/i18n/runtime'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'

const user = { id: 'owner-install', email: 'owner@example.test', nickname: 'Owner' }
let harness: ReturnType<typeof createReactHarness>
let tourEntry: HTMLButtonElement | undefined
let tourRail: HTMLElement | undefined
const byId = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const notice = () => byId('first-run-install-notification')

beforeEach(async () => {
  vi.clearAllMocks()
  queryClient.clear()
  sessionStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  await i18n.changeLanguage('en-US')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  tourRail?.remove()
  tourRail = undefined
  tourEntry = undefined
  queryClient.clear()
  vi.unstubAllGlobals()
})

async function startAndVisitSetup() {
  await renderWithAppProviders(harness, createNode(FirstRunGate, { user }, createNode('main', {}, 'Main workspace')), { auth: user })
  await waitForCondition(() => !!byId('first-run-harness-continue') && !(byId('first-run-harness-continue') as HTMLButtonElement).disabled, 'agent selection ready')
  await clickElement(byId('first-run-harness-continue')!)
  await waitForCondition(() => !!byId('first-run-terminal'), 'terminal page')
  expect(native.install).toHaveBeenCalledOnce()
  expect(notice()).toBeNull()

  // Installation continues while the person returns through Agent and profile pages.
  await clickElement(byId('first-run-terminal-back')!)
  expect(notice()).toBeNull()
  await clickElement(byId('first-run-harness-back')!)
  await waitForCondition(() => !!byId('first-run-profile'), 'profile page')
  expect(notice()).toBeNull()
  await clickElement(byId('first-run-profile-continue')!)
  await waitForCondition(() => !!byId('first-run-harness-continue'), 'agent selection again')
  await clickElement(byId('first-run-harness-continue')!)
  await waitForCondition(() => !!byId('first-run-terminal'), 'terminal again')
  expect(native.install).toHaveBeenCalledOnce()
  await clickElement(byId('first-run-terminal-continue')!)
  expect(byId('first-run-tour-choice')).not.toBeNull()
  expect(notice()).toBeNull()
}

describe('installation notices appear only after full-screen first-run pages', () => {
  async function enterWorkspace() {
    expect(byId('first-run-tour-choice')).not.toBeNull()
    expect(notice()).toBeNull()
    await clickElement(byId('first-run-tour-skip')!)
  }

  it('keeps installing without a setup notice, then displays progress in the main workspace', async () => {
    native.install.mockImplementation(() => new Promise(() => {}))
    await startAndVisitSetup()
    await enterWorkspace()
    await waitForCondition(() => !!notice(), 'installation progress in workspace')
    expect(harness.container.textContent).toContain('Main workspace')
    expect(notice()!.querySelector('[data-testid="install-progress-track"]')).not.toBeNull()
    expect(native.install).toHaveBeenCalledOnce()
  })

  it('retains an installation failure during setup and displays it after entering the main workspace', async () => {
    let fail!: (cause: Error) => void
    native.install.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    await startAndVisitSetup()
    await act(async () => fail(new Error('Download failed')))
    expect(notice()).toBeNull()
    await enterWorkspace()
    await waitForCondition(() => !!notice(), 'installation failure in workspace')
    expect(notice()!.querySelector('[role="alert"]')?.textContent).toContain('Download failed')
    expect(notice()!.textContent).toContain('Retry')
  })

  it.each(['complete', 'skip'] as const)('hides the installation notice throughout the tour and restores it after %s', async (exit) => {
    native.install.mockImplementation(() => new Promise(() => {}))
    await startAndVisitSetup()
    tourEntry = document.createElement('button')
    tourEntry.dataset.rail = 'settings'
    tourEntry.scrollIntoView = vi.fn()
    tourEntry.getBoundingClientRect = () => ({ x: 0, y: 40, top: 40, left: 0, right: 40, bottom: 80, width: 40, height: 40, toJSON() {} })
    tourRail = document.createElement('nav')
    tourRail.className = 'gg-sidebar-rail'
    tourRail.append(tourEntry)
    document.body.append(tourRail)
    await clickElement(byId('first-run-tour-start')!)
    await waitForCondition(() => !!document.querySelector('[data-testid="product-tour-step-settings"]'), 'tour card shown')
    expect(notice()).toBeNull()

    if (exit === 'complete') await clickElement(document.querySelector('[data-testid="product-tour-next"]')!)
    else await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await waitForCondition(() => !!notice(), 'installation progress restored after tour')
    expect(document.querySelector('[data-testid="product-tour-step-settings"]')).toBeNull()
    expect(notice()!.querySelector('[data-testid="install-progress-track"]')).not.toBeNull()
    expect(native.install).toHaveBeenCalledOnce()
  })

  // owner 11-12: no step about the assistant in the first run (it is an App; getting to know it happens in the App).
  it.each([
    ['zh-CN', '咕咕和你的 agent 会用这些称呼你。'],
    ['en-US', 'Gugu and your agents will use these details to address you.'],
  ])('%s: the desktop first run is profile, agents, terminal, tour choice — four steps, none about the assistant', async (locale, profileCopy) => {
    await i18n.changeLanguage(locale)
    native.install.mockImplementation(() => new Promise(() => {}))
    const counts: string[] = []
    const count = () => byId('first-run-step-count')?.textContent ?? null
    await renderWithAppProviders(harness, createNode(FirstRunGate, { user }, createNode('main', {}, 'Main workspace')), { auth: user })
    await waitForCondition(() => !!byId('first-run-harness-continue') && !(byId('first-run-harness-continue') as HTMLButtonElement).disabled, 'agent selection ready')
    await clickElement(byId('first-run-harness-back')!)
    await waitForCondition(() => !!byId('first-run-profile'), 'profile page')
    expect(byId('first-run-profile')!.querySelector('.ta-onb-sub')?.textContent).toBe(profileCopy)
    counts.push(count()!)
    await clickElement(byId('first-run-profile-continue')!)
    await waitForCondition(() => !!byId('first-run-harness-continue'), 'agents page')
    counts.push(count()!)
    await clickElement(byId('first-run-harness-continue')!)
    await waitForCondition(() => !!byId('first-run-terminal'), 'terminal page')
    counts.push(count()!)
    await clickElement(byId('first-run-terminal-continue')!)
    await waitForCondition(() => !!byId('first-run-tour-choice'), 'tour choice')
    counts.push(count()!)
    expect(counts).toEqual(['1 / 4', '2 / 4', '3 / 4', '4 / 4'])
    // Nothing on the way introduces or sets up the assistant.
    expect(byId('first-run-intro')).toBeNull()
    expect(harness.container.querySelector('[data-testid^="assistant-intro-"]')).toBeNull()
    // Back from the last page is the terminal page.
    await clickElement(byId('first-run-tour-back')!)
    await waitForCondition(() => !!byId('first-run-terminal'), 'terminal again')
    expect(count()).toBe('3 / 4')
  })
})
