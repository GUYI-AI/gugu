// @vitest-environment jsdom
// #7348 新账号的第一次打开(product spec):手机只有「认识你」一页,「继续」即走完(owner 11-12:没有认识咕咕那一步,
// 认识它在助理 App 里);老账号 / 走完的直接进主界面;进度读不到如实说 + 重试,❌ 当新账号重走,❌ 当走完放行。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'
import { StartupMotionBoundary } from '../../../../apps/desktop/src/components/StartupMotionBoundary'
import { discardStartupMotion, startStartupMotion } from '../../../../apps/desktop/src/lib/startup-motion'

const io = vi.hoisted(() => ({
  firstRunDoneHere: vi.fn((_userId: string) => false),
  rememberFirstRunDone: vi.fn(),
  readFirstRunProgress: vi.fn(),
  writeOccupation: vi.fn(async () => undefined),
  finishFirstRun: vi.fn(async () => '2026-10-16T00:00:00Z'),
  startFirstRunHints: vi.fn(async () => undefined),
  enrollSampleProject: vi.fn(async (_userId: string) => undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => io)
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', () => ({ startFirstRunHints: io.startFirstRunHints, readFirstRunHints: vi.fn(async () => null), dismissFirstRunHints: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => ({ enrollSampleProject: io.enrollSampleProject }))
const auth = vi.hoisted(() => ({ updateNickname: vi.fn(async () => ({ success: true })), updateAvatar: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: auth }))
const installer = vi.hoisted(() => ({ mounted: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/firstRun/FirstRunInstallProvider', () => ({
  FirstRunInstallProvider: ({ children }: { children: import('react').ReactNode }) => {
    installer.mounted()
    return children
  },
}))

const { FirstRunGate } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunGate')

const user = { id: 'u1', email: 'neo@example.com', nickname: 'neo' }
const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function renderGate(overrides: Partial<typeof user & { identityPending: boolean }> = {}) {
  const harness = createReactHarness()
  const node = createNode(FirstRunGate, { user: { ...user, ...overrides } }, createNode('div', { 'data-testid': 'main-product' }))
  await renderWithAppProviders(harness, node, { auth: { ...user, ...overrides } })
  return harness
}

afterEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

describe('first run gate (#7348)', () => {
  it('continues cold-start motion only through the initial read, then uses the ordinary loader on retry', async () => {
    const boot = document.createElement('div')
    boot.setAttribute('data-gugu-boot', '')
    boot.style.color = 'rgb(26, 28, 31)'
    boot.style.backgroundColor = 'white'
    document.body.append(boot)
    const frame = startStartupMotion()!.frame
    let fail!: (error: Error) => void
    let finish!: (value: { stage: string; occupation: null }) => void
    io.readFirstRunProgress.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    io.readFirstRunProgress.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const harness = createReactHarness()
    try {
      await renderWithAppProviders(harness, createNode(StartupMotionBoundary, {},
        createNode(FirstRunGate, { user }, createNode('div', { 'data-testid': 'main-product' }))), { auth: user })
      expect(document.querySelector('[data-gugu-boot] iframe')).toBe(frame)
      expect(byTestId(harness.container, 'loading-indicator')).toBeNull()
      await act(async () => { fail(new Error('progress temporarily unavailable')) })
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-unreadable'), 'initial read failed honestly')
      await waitForCondition(() => !document.querySelector('[data-gugu-boot]'), 'startup ends at the first actionable screen')
      await clickElement(byTestId(harness.container, 'first-run-retry')!)
      expect(byTestId(harness.container, 'loading-indicator')).not.toBeNull()
      expect(document.querySelector('[data-gugu-boot]')).toBeNull()
      await act(async () => { finish({ stage: 'done', occupation: null }) })
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'retry completes without another startup')
    } finally {
      harness.cleanup()
      discardStartupMotion()
    }
  })

  it('does not mount the desktop harness installer on web or phone', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'phone-capable product rendered')
      expect(installer.mounted).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('finished / existing accounts go straight to the product', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product rendered')
      expect(byTestId(harness.container, 'first-run-profile')).toBeNull()
    } finally {
      harness.cleanup()
    }
  })

  it('a device that already read "finished" for this account lets it straight in without asking again (offline / slow network)', async () => {
    io.firstRunDoneHere.mockImplementation((userId: string) => userId === 'u1')
    io.readFirstRunProgress.mockRejectedValue(new Error('network down'))
    const harness = await renderGate()
    try {
      expect(byTestId(harness.container, 'main-product')).not.toBeNull()
      expect(byTestId(harness.container, 'full-screen-loader')).toBeNull()
      expect(io.readFirstRunProgress).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
      io.firstRunDoneHere.mockImplementation(() => false)
      io.readFirstRunProgress.mockReset()
    }
  })

  it('only a read that says "finished" is remembered; "not finished" and "unreadable" are not', async () => {
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'done', occupation: null })
    const done = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(done.container, 'main-product'), 'product rendered')
      expect(io.rememberFirstRunDone).toHaveBeenCalledWith('u1')
    } finally {
      done.cleanup()
    }
    vi.clearAllMocks()
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'profile', occupation: null })
    const profile = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(profile.container, 'first-run-profile'), 'profile screen')
    } finally {
      profile.cleanup()
    }
    io.readFirstRunProgress.mockRejectedValueOnce(new Error('network down'))
    const unreadable = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(unreadable.container, 'first-run-unreadable'), 'unreadable screen')
    } finally {
      unreadable.cleanup()
    }
    expect(io.rememberFirstRunDone).not.toHaveBeenCalled()
  })

  it('unreadable progress says so and retries; it neither replays the flow nor lets you through', async () => {
    io.readFirstRunProgress.mockRejectedValueOnce(new Error('permission denied for table users'))
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-unreadable'), 'unreadable screen')
      expect(harness.container.textContent).toContain('permission denied for table users')
      expect(byTestId(harness.container, 'first-run-retry')).not.toBeNull()
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      expect(byTestId(harness.container, 'first-run-profile')).toBeNull()
      await clickElement(byTestId(harness.container, 'first-run-retry')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product after retry')
    } finally {
      harness.cleanup()
    }
  })

  it('does not wait for the identity to finish hydrating (a hydration that never lands must not leave the gate spinning)', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate({ identityPending: true, nickname: '' })
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product rendered while identity is pending')
      expect(io.readFirstRunProgress).toHaveBeenCalledWith('u1')
    } finally {
      harness.cleanup()
    }
  })

  it('profile: a name that arrives after hydration fills the field, but never overwrites what the person typed', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'profile', occupation: null })
    const harness = createReactHarness()
    const render = (overrides: Partial<typeof user & { identityPending: boolean }>) =>
      renderWithAppProviders(harness, createNode(FirstRunGate, { user: { ...user, ...overrides } }, createNode('div', { 'data-testid': 'main-product' })))
    try {
      await render({ identityPending: true, nickname: '' })
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile'), 'profile screen before hydration')
      const name = () => byTestId(harness.container, 'first-run-name') as HTMLInputElement
      expect(name().value).toBe('')
      await render({ nickname: 'neo' })
      expect(name().value).toBe('neo')
      await typeInto(name(), 'Neo')
      await render({ nickname: 'neo-renamed-elsewhere' })
      expect(name().value).toBe('Neo')
    } finally {
      harness.cleanup()
    }
  })

  it('profile: name prefilled, occupation required ("other" needs its sentence); its 「continue」 finishes the first run', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'profile', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile'), 'profile screen')
      // The only page here: no 「1 / 1」.
      expect(byTestId(harness.container, 'first-run-step-count')).toBeNull()
      const name = byTestId(harness.container, 'first-run-name') as HTMLInputElement
      expect(name.value).toBe('neo')
      const next = byTestId(harness.container, 'first-run-profile-continue') as HTMLButtonElement
      expect(next.disabled).toBe(true)
      await clickElement(byTestId(harness.container, 'first-run-occupation-other')!)
      expect(next.disabled).toBe(true)
      await typeInto(byTestId(harness.container, 'first-run-occupation-other-text') as HTMLInputElement, '律师')
      await typeInto(name, 'Neo')
      expect(next.disabled).toBe(false)
      await clickElement(next)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product after the profile')
      expect(auth.updateNickname).toHaveBeenCalledWith('u1', 'Neo')
      expect(io.writeOccupation).toHaveBeenCalledWith('u1', { key: 'other', text: '律师' })
      // #709 the sample project is enrolled before the first run is recorded as finished.
      expect(io.startFirstRunHints).toHaveBeenCalledWith('u1')
      expect(io.enrollSampleProject).toHaveBeenCalledWith('u1')
      expect(io.enrollSampleProject.mock.invocationCallOrder[0]).toBeLessThan(io.finishFirstRun.mock.invocationCallOrder[0]!)
      expect(io.rememberFirstRunDone).toHaveBeenCalledWith('u1')
      expect(byTestId(harness.container, 'first-run-intro')).toBeNull()
    } finally {
      harness.cleanup()
    }
  })

  it('progress an older build saved on its 「认识咕咕」 page resumes on the filled-in profile, whose 「continue」 finishes', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'research' } })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile'), 'profile again')
      expect(byTestId(harness.container, 'first-run-occupation-research')?.getAttribute('aria-checked')).toBe('true')
      expect(byTestId(harness.container, 'assistant-intro-primary')).toBeNull()
      await clickElement(byTestId(harness.container, 'first-run-profile-continue')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product after continue')
      expect(io.finishFirstRun).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })

  it('does not finish the first run if enrolling account hint progress fails; 「continue」 again does', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'design' } })
    io.startFirstRunHints.mockRejectedValueOnce(new Error('hint progress unavailable'))
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile-continue'), 'profile')
      await clickElement(byTestId(harness.container, 'first-run-profile-continue')!)
      await waitForCondition(() => !!harness.container.querySelector('[role="alert"]'), 'enrollment failure')
      expect(io.finishFirstRun).not.toHaveBeenCalled()
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      await clickElement(byTestId(harness.container, 'first-run-profile-continue')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'enrollment retry')
      expect(io.finishFirstRun).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })

  it('a failed finish keeps you on the profile and says it did not save (❌ silently entering the product)', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'design' } })
    io.finishFirstRun.mockRejectedValueOnce(new Error('network down'))
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile-continue'), 'profile')
      await clickElement(byTestId(harness.container, 'first-run-profile-continue')!)
      await waitForCondition(() => !!harness.container.querySelector('[role="alert"]'), 'error shown')
      expect(harness.container.textContent).toContain('network down')
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      expect(byTestId(harness.container, 'first-run-profile-continue')).not.toBeNull()
      expect(io.rememberFirstRunDone).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })
})
