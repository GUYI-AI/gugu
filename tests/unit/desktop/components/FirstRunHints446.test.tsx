// @vitest-environment jsdom
import { act } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'
import { stubLayoutIntersection } from '../../../support/layoutIntersection'
import type { FirstRunHintId, FirstRunHintsProgress } from '../../../../apps/desktop/src/lib/firstRunHints'

const io = vi.hoisted(() => ({ read: vi.fn(), dismiss: vi.fn(), warn: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', async (importOriginal) => ({ ...(await importOriginal<object>()), dismissFirstRunHints: io.dismiss }))
// The hints are a key of the account's own `user` settings row (the ownSettings replica): its read is the account read.
vi.mock('@gugu/core/cloud/userSettings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserSettingsConfig: async () => { const progress = await io.read(); return progress ? { firstRunHints: progress } : {} },
}))
vi.mock('../../../../apps/desktop/src/lib/log', async (importOriginal) => ({ ...(await importOriginal<object>()), rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: io.warn, error: vi.fn() }) }))
const { FirstRunHints } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunHints')
const { AssistantIntro } = await import('../../../../apps/desktop/src/components/assistant/AssistantIntro')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')
const replica = await import('../../../../apps/desktop/src/lib/replica')
const { ownSettings } = await import('../../../../apps/desktop/src/lib/ownSettings')
const shownProgress = () => { const reading = ownSettings.peek('user'); return reading.state === 'value' ? reading.value.firstRunHints : undefined }

type Device = 'phone' | 'desktop'
let account: FirstRunHintsProgress | null
const cleanup: (() => void)[] = []
beforeEach(async () => {
  account = { version: 1, dismissed: [] }
  io.warn.mockReset()
  io.read.mockReset().mockImplementation(async () => account)
  io.dismiss.mockReset().mockImplementation(async (_owner, ids: FirstRunHintId[]) => {
    account = { version: 1, dismissed: [...new Set([...(account?.dismissed ?? []), ...ids])] }
    // The save puts the saved row into the replica (updateOwnSettingsKey does that in the product).
    ownSettings.set(['user'], { firstRunHints: account })
    return account
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  stubLayoutIntersection()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, 40, 100, 44))
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup.splice(0).reverse().forEach((fn) => fn())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setDevice(device: Device) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: device === 'phone' ? 390 : 1280 })
}
function addEntry(device: Device, id: FirstRunHintId) {
  const region = document.createElement('section')
  if (device === 'phone' && id === 'collaboration') region.className = 'gg-partners'
  if (device === 'desktop' && id === 'assistant') region.className = 'gg-sidebar-rail'
  const entry = document.createElement(id === 'assistant' ? 'button' : 'div')
  entry.dataset.firstRunHint = id
  entry.dataset.firstRunDevice = device
  if (device === 'desktop' && id === 'assistant') entry.dataset.rail = 'assistant'
  if (id === 'collaboration') entry.innerHTML = device === 'phone' ? '<button data-testid="phone-partners-project">Project</button>' : '<button>Projects</button>'
  region.append(entry)
  document.body.append(region)
  cleanup.push(() => region.remove())
  return { region, use: region.querySelector<HTMLElement>('[role="button"], button')! }
}
async function mount(device: Device) {
  setDevice(device)
  const h = createReactHarness()
  // Each mount is a fresh renderer (another device, or the app opened again): nothing read yet.
  replica.queryClient.clear()
  replica.followRendererSession('SIGNED_IN', 'owner-1')
  await h.render(createNode(QueryClientProvider, { client: replica.queryClient }, createNode(FirstRunHints, { userId: 'owner-1' })))
  const close = () => { h.cleanup(); replica.queryClient.clear() }
  cleanup.push(close)
  return { ...h, close }
}
const bubble = (id: FirstRunHintId) => document.querySelector<HTMLElement>(`[data-testid="first-run-hint-${id}"]`)
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('device-specific one-page introduction', () => {
  it.each(['phone', 'desktop'] as const)('uses the approved %s entry names and copy', async (device) => {
    setDevice(device)
    const h = createReactHarness()
    cleanup.push(h.cleanup)
    await h.render(createNode(AssistantIntro, { primaryLabel: '开通我的咕咕', onPrimary: vi.fn(), laterLabel: '先逛逛', onLater: vi.fn() }))
    expect([...h.container.querySelectorAll('[data-intro-row]')].map((row) => row.getAttribute('data-intro-row'))).toEqual(device === 'phone' ? ['gugu', 'messages', 'partners'] : ['gugu', 'projects', 'chats'])
    expect(h.container.querySelector('.ta-onb-intro-gugu')?.textContent).toContain(device === 'phone' ? '咕咕位于「消息」列表第一行。' : '你的个人助理，用于记录安排、处理事务。')
    // The desktop says nothing of where it is: it is the first App of the rail's App group, not the top of the rail.
    if (device === 'desktop') expect(h.container.querySelector('.ta-onb-intro-gugu')?.textContent).not.toContain('左栏')
    expect(h.container.textContent).not.toContain('每件任务')
    expect(h.container.querySelector('.ta-onb-intro')?.children).toHaveLength(2)
  })
})

describe('contextual hints at the entries each device draws', () => {
  it('shares completion with the corresponding entry on another device', async () => {
    const entry = addEntry('phone', 'assistant')
    const first = await mount('phone')
    await waitForCondition(() => io.read.mock.calls.length === 1, 'phone reads account')
    await clickElement(entry.use)
    await waitForCondition(() => account?.dismissed.includes('assistant') === true, 'account saved')
    first.close()
    addEntry('desktop', 'assistant')
    await mount('desktop')
    await waitForCondition(() => io.read.mock.calls.length === 2, 'desktop reads account')
    expect(bubble('assistant')).toBeNull()
  })

  it('desktop: draws no collaboration hint and records opening a project', async () => {
    const old = addEntry('desktop', 'collaboration')
    const project = document.createElement('button')
    project.dataset.projectRow = 'p-1'
    old.region.append(project)
    await mount('desktop')
    await waitForCondition(() => io.read.mock.calls.length === 1, 'account read')
    expect(bubble('collaboration')).toBeNull()
    await clickElement(project)
    await waitForCondition(() => account?.dismissed.includes('collaboration') === true, 'opened project saved')
  })

  it.each(['phone', 'desktop'] as const)('%s: skips observing entries with no remaining hints', async (device) => {
    account = { version: 1, dismissed: ['assistant'] }
    const observed = vi.spyOn(MutationObserver.prototype, 'observe')
    await mount(device)
    await waitForCondition(() => io.read.mock.calls.length === 1, 'account read')
    expect(observed.mock.calls.some(([target]) => target === document.body)).toBe(false)
  })

  it('keeps both phone hint cards hidden for a fresh account', async () => {
    addEntry('phone', 'assistant')
    addEntry('phone', 'collaboration')
    await mount('phone')
    await waitForCondition(() => ownSettings.peek('user').state === 'value', 'account read')
    expect(bubble('assistant')).toBeNull()
    expect(bubble('collaboration')).toBeNull()
    expect(io.dismiss).not.toHaveBeenCalled()
  })

  it('never shows hints for existing accounts', async () => {
    account = null
    addEntry('desktop', 'assistant')
    await mount('desktop')
    await waitForCondition(() => io.read.mock.calls.length === 1, 'account read')
    expect(bubble('assistant')).toBeNull()
    expect(io.dismiss).not.toHaveBeenCalled()
  })

  it('a failed read shows no hint and invents no progress; the next read of the row brings the progress back', async () => {
    // Transient failures are read again by the data client itself (postgrest-js 1 s / 2 s / 4 s, below this mock): what
    // reaches the replica is a failure that outlived them, and the row has no second retry layer on top.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    io.read.mockRejectedValue(new Error('local request failed: code=1'))
    addEntry('desktop', 'assistant')
    await mount('desktop')
    await advance(60_000)
    expect(io.read).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid^="first-run-hint-"], [role="alert"], [data-sonner-toast]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/code=1|Retry|提示进度/)
    // No progress made up: the reading is an error, never a value.
    expect(ownSettings.peek('user').state).toBe('error')
    expect(io.dismiss).not.toHaveBeenCalled()
    io.read.mockImplementation(async () => account)
    await act(async () => { await ownSettings.refresh('user') })
    await advance(1)
    expect(shownProgress()).toEqual({ version: 1, dismissed: [] })
  })

  it('remembers use while progress is loading and never flashes that hint afterwards', async () => {
    let resolve!: (value: FirstRunHintsProgress) => void
    io.read.mockImplementationOnce(() => new Promise<FirstRunHintsProgress>((done) => { resolve = done }))
    const entry = addEntry('phone', 'assistant')
    await mount('phone')
    await clickElement(entry.use)
    expect(bubble('assistant')).toBeNull()
    await act(async () => resolve({ version: 1, dismissed: [] }))
    await waitForCondition(() => account?.dismissed.includes('assistant') === true, 'early use saved')
    expect(bubble('assistant')).toBeNull()
  })
})
