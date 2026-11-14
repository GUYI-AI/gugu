// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
const io = vi.hoisted(() => ({
  firstRunDoneHere: vi.fn((_userId: string) => false),
  rememberFirstRunDone: vi.fn(),
  readFirstRunProgress: vi.fn(async () => ({
    stage: 'intro', occupation: { key: 'research' }, harness: ['codex'], terminalSeen: true,
    tour: { phase: 'features', index: 3 },
  })),
  finishFirstRun: vi.fn(async () => '2026-10-24T00:00:00Z'),
  writeOccupation: vi.fn(),
  writeFirstRunHarness: vi.fn(),
  enrollSampleProject: vi.fn(async (_userId: string) => undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => io)
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', () => ({ startFirstRunHints: vi.fn(async () => undefined), readFirstRunHints: vi.fn(async () => null), dismissFirstRunHints: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => ({ enrollSampleProject: io.enrollSampleProject }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: {} }))
vi.mock('../../../../apps/desktop/src/components/firstRun/FirstRunTerminal', () => ({
  FirstRunTerminal: ({ onDone }: { onDone: () => void }) => createNode('button', { 'data-testid': 'terminal-continue', onClick: onDone }, 'Continue'),
}))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), saveProductTourPosition: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => {
  const rpc = { agents: { list: async () => [], listAgentInstallationStatus: async () => [] } }
  return { rpc, rpcOn: () => rpc, events: { on: () => () => {} }, onMachineEvent: () => () => {} }
})

// Native module imports evaluate once per document. A second import resolves without bootstrapping
// into another element, matching the actual embedded entry rather than concealing a host remount.
const entry = vi.hoisted(() => ({ evaluated: false, importSessionEntry: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/sessionpage/importSessionEntry', () => ({
  importSessionEntry: entry.importSessionEntry,
}))

import { FirstRunGate } from '../../../../apps/desktop/src/components/firstRun/FirstRunGate'
import { EmdashSessionFrame } from '../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { i18n } from '../../../../apps/desktop/src/i18n/runtime'

const sessionMount = () => (window as unknown as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__

describe('desktop product lifetime across the first-run tour', () => {
  let harness: ReturnType<typeof createReactHarness>

  beforeEach(async () => {
    vi.clearAllMocks()
    entry.evaluated = false
    entry.importSessionEntry.mockImplementation(async () => {
      if (entry.evaluated) return
      entry.evaluated = true
      const content = document.createElement('div')
      content.textContent = 'Task page ready'
      sessionMount()!.appendChild(content)
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => '<script type="module" src="./assets/session-lifetime-test.js"></script>',
    })))
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    await i18n.changeLanguage('en-US')
    harness = createReactHarness()
  })

  afterEach(() => {
    harness.cleanup()
    vi.unstubAllGlobals()
    delete (window as unknown as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__
  })

  // Progress saved by an older build on its 「认识咕咕」 page (stage `intro`, agents picked, terminal seen) resumes on the
  // next page that still exists: the tour choice, 4 / 4 (owner 11-12: no assistant step in the first run).
  it('keeps the same connected task mount from a saved older-build progress through the tour choice and reopening the tour', async () => {
    await harness.render(createNode(FirstRunGate, {
      user: { id: 'owner-1', email: 'owner@example.test', nickname: 'Owner' },
    }, createNode(EmdashSessionFrame)))
    await waitForCondition(() => sessionMount()?.textContent === 'Task page ready', 'embedded task page rendered')
    const mount = sessionMount()!
    const content = mount.firstElementChild
    expect(mount.isConnected).toBe(true)
    expect(content).not.toBeNull()
    // Desktop asks once whether to take the feature-bar tour (onboarding spec §4.1).
    await waitForCondition(() => !!document.querySelector('[data-testid="first-run-tour-choice"]'), 'tour choice shown')
    expect(document.querySelector('[data-testid="first-run-step-count"]')?.textContent).toBe('4 / 4')
    expect(document.querySelector('[data-testid^="assistant-intro-"]')).toBeNull()
    expect(io.finishFirstRun).not.toHaveBeenCalled()
    expect(io.enrollSampleProject).not.toHaveBeenCalled()
    await clickElement(document.querySelector('[data-testid="first-run-tour-skip"]')!)
    await waitForCondition(() => !document.querySelector('[data-testid="first-run-tour-choice"]'), 'choice dismissed')

    expect(io.finishFirstRun).toHaveBeenCalledOnce()
    expect(io.enrollSampleProject).toHaveBeenCalledWith('owner-1')
    expect(io.enrollSampleProject.mock.invocationCallOrder[0]).toBeLessThan(io.finishFirstRun.mock.invocationCallOrder[0]!)
    expect(sessionMount()).toBe(mount)
    expect(mount.isConnected).toBe(true)
    expect(mount.firstElementChild).toBe(content)
    expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
    expect(entry.importSessionEntry).toHaveBeenCalledOnce()

    // Reopening from Help & tour crosses the same boundary in reverse and must preserve the root too.
    await act(async () => {
      window.dispatchEvent(new Event(UI_EVENTS.reopenProductTour))
    })
    expect(sessionMount()).toBe(mount)
    expect(mount.isConnected).toBe(true)
    expect(mount.firstElementChild).toBe(content)
    expect(entry.importSessionEntry).toHaveBeenCalledOnce()
  })
  // #709 最后一页(问导览)两个出口都给新账号记上示例项目,在「走完」之前记。
  it.each(['first-run-tour-start', 'first-run-tour-skip'])('%s enrolls the sample project before finishing', async (choice) => {
    await harness.render(createNode(FirstRunGate, {
      user: { id: 'owner-1', email: 'owner@example.test', nickname: 'Owner' },
    }, createNode(EmdashSessionFrame)))
    await waitForCondition(() => !!document.querySelector('[data-testid="first-run-tour-choice"]'), 'tour choice shown')
    expect(io.enrollSampleProject).not.toHaveBeenCalled()
    await clickElement(document.querySelector(`[data-testid="${choice}"]`)!)
    await waitForCondition(() => io.finishFirstRun.mock.calls.length === 1, 'finished')
    expect(io.enrollSampleProject).toHaveBeenCalledWith('owner-1')
    expect(io.enrollSampleProject.mock.invocationCallOrder[0]).toBeLessThan(io.finishFirstRun.mock.invocationCallOrder[0]!)
  })

  it('keeps the task page connected when going back from the tour choice to the terminal step', async () => {
    await harness.render(createNode(FirstRunGate, {
      user: { id: 'owner-1', email: 'owner@example.test', nickname: 'Owner' },
    }, createNode(EmdashSessionFrame)))
    await waitForCondition(() => sessionMount()?.textContent === 'Task page ready', 'embedded task page rendered')
    const mount = sessionMount()!
    const content = mount.firstElementChild
    await waitForCondition(() => !!document.querySelector('[data-testid="first-run-tour-back"]'), 'tour choice shown')
    await clickElement(document.querySelector('[data-testid="first-run-tour-back"]')!)
    expect(mount.isConnected).toBe(true)
    await clickElement(document.querySelector('[data-testid="terminal-continue"]')!)
    await waitForCondition(() => !!document.querySelector('[data-testid="first-run-tour-choice"]'), 'tour choice shown again')
    await clickElement(document.querySelector('[data-testid="first-run-tour-skip"]')!)
    expect(sessionMount()).toBe(mount)
    expect(mount.firstElementChild).toBe(content)
    expect(entry.importSessionEntry).toHaveBeenCalledOnce()
    expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
  })

})
