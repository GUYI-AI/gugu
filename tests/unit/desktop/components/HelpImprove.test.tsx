// @vitest-environment jsdom
// 「帮助改进咕咕」(owner 11-09 方案 B):首登第一页「继续」下面一行勾选,默认勾着;设置 → 通用里是同一个开关。
// 主进程读不到这个开关就整行不出现;没存上要如实说,开关不假装已经改了。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({
  firstRunDoneHere: vi.fn((_userId: string) => false),
  rememberFirstRunDone: vi.fn(),
  readFirstRunProgress: vi.fn(async () => ({ stage: 'profile', occupation: null })),
  writeOccupation: vi.fn(async () => undefined),
  finishFirstRun: vi.fn(async () => '2026-11-09T00:00:00Z'),
  startFirstRunHints: vi.fn(async () => undefined),
  enrollSampleProject: vi.fn(async (_userId: string) => undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => io)
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', () => ({ startFirstRunHints: io.startFirstRunHints, readFirstRunHints: vi.fn(async () => null), dismissFirstRunHints: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => ({ enrollSampleProject: io.enrollSampleProject }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: { updateNickname: vi.fn(async () => ({ success: true })), updateAvatar: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/components/firstRun/FirstRunInstallProvider', () => ({
  FirstRunInstallProvider: ({ children }: { children: import('react').ReactNode }) => children,
}))

const user = { id: 'u1', email: 'neo@example.com', nickname: 'neo' }
const byTestId = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string) => root.querySelector<T>(`[data-testid="${id}"]`)
const scope = 'a'.repeat(64)

// One main-process stand-in for the whole file; each test sets what it answers and announces a change.
const host = vi.hoisted(() => ({
  read: async (): Promise<unknown> => null,
  write: async (decision: string): Promise<unknown> => ({ eligible: true, context: 'a'.repeat(64), decision }),
  changed: () => {},
}))
const invoke = vi.fn(async (channel: string, decision?: string) => {
  if (channel === 'error-summary:consent-read') return host.read()
  if (channel === 'error-summary:consent-write') return host.write(decision!)
  throw new Error(`unexpected ${channel}`)
})
Object.assign(window, { electronAPI: { invoke, eventOn: (_channel: string, listener: () => void) => { host.changed = listener }, eventSend: vi.fn() } })
const consent = await import('../../../../apps/desktop/src/lib/errorSummaryConsent')
consent.installErrorSummaryConsent()
const { FirstRunGate } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunGate')
const { HelpImproveSettingGroup } = await import('../../../../apps/desktop/src/components/HelpImprove')

async function answer(read: () => Promise<unknown>) {
  host.read = read
  await act(async () => { host.changed(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(async () => {
  host.write = async (decision: string) => ({ eligible: true, context: scope, decision })
  await answer(async () => ({ eligible: true, context: scope, decision: 'allowed' }))
  invoke.mockClear()
})
afterEach(() => { vi.clearAllMocks() })

describe('help improve Gugu on the first-run profile page', () => {
  it('sits under Continue, checked by default, and unchecking it turns reporting off for this account', async () => {
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(harness, createNode(FirstRunGate, { user }, createNode('div', {})), { auth: user })
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-help-improve'), 'help improve line rendered')
      const box = byTestId<HTMLInputElement>(harness.container, 'first-run-help-improve')!
      const continueButton = byTestId(harness.container, 'first-run-profile-continue')!
      expect(box.checked).toBe(true)
      expect(box.closest('label')!.textContent).toBe('帮助改进咕咕：出错时自动发送错误摘要，不含对话和文件内容')
      expect(continueButton.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(continueButton.parentElement).toBe(box.closest('label')!.parentElement)

      await clickElement(box)
      await waitForCondition(() => !box.checked, 'unchecked after saving')
      expect(invoke).toHaveBeenCalledWith('error-summary:consent-write', 'denied', scope)
    } finally {
      harness.cleanup()
    }
  })

  it('does not appear where this device cannot record the choice', async () => {
    await answer(async () => { throw new Error('No handler registered') })
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(harness, createNode(FirstRunGate, { user }, createNode('div', {})), { auth: user })
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile-continue'), 'profile rendered')
      expect(byTestId(harness.container, 'first-run-help-improve')).toBeNull()
    } finally {
      harness.cleanup()
    }
  })
})

describe('help improve Gugu in Settings → General', () => {
  it('shows the account choice and says so when turning it off was not saved', async () => {
    host.write = async () => { throw new Error('disk full') }
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(harness, createNode(HelpImproveSettingGroup, {}), { auth: user })
      const group = byTestId(harness.container, 'settings-help-improve')!
      expect(group.textContent).toContain('帮助改进咕咕')
      expect(group.textContent).toContain('不含对话和文件内容')
      const toggle = group.querySelector<HTMLElement>('[role="switch"]')!
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      await clickElement(toggle)
      await waitForCondition(() => !!group.querySelector('[role="alert"]'), 'save failure shown')
      expect(toggle.getAttribute('aria-checked')).toBe('true')
    } finally {
      harness.cleanup()
    }
  })

  it('follows a change made in another window or by switching accounts', async () => {
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(harness, createNode(HelpImproveSettingGroup, {}), { auth: user })
      const toggle = () => byTestId(harness.container, 'settings-help-improve')!.querySelector<HTMLElement>('[role="switch"]')!
      expect(toggle().getAttribute('aria-checked')).toBe('true')
      await answer(async () => ({ eligible: true, context: scope, decision: 'denied' }))
      await waitForCondition(() => toggle().getAttribute('aria-checked') === 'false', 'switch follows main process')
    } finally {
      harness.cleanup()
    }
  })
})
