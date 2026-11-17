// @vitest-environment jsdom
// App architecture I5: the App page's 「给了…」 summary agrees with the runtime. Switched off here, or its agent tools taken back,
// no agent gets them whoever it is given to — the summary says so instead of listing who it is 「given to」.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

// The section reads its places through the host's API (`appPlaces(hostKey, id)`): another machine's key, answered here.
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, rpcOn: () => ({ extensions: api }), events: { on: () => () => {} }, onMachineEvent: () => () => {} }))
const { AppGivenSection } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-given-section')

let harness: ReturnType<typeof createReactHarness>
// Which agents an App is given to are the signed-in account's (account scope): read for a signed-in account, as in the product.
const { followRendererSession } = await import('../../../../apps/desktop/src/lib/replica')
beforeEach(() => { answer.fail = false; followRendererSession('SIGNED_IN', 'owner'); harness = createReactHarness() })
afterEach(() => harness.cleanup())

const answer = vi.hoisted(() => ({ fail: false }))
const api = vi.hoisted(() => ({
  appPlaces: async () => (answer.fail ? { success: false as const, error: 'machine unreachable' } : { success: true as const, data: [{ id: 'here:all', kind: 'here' as const, enabled: true }] }),
  changeAppPlaces: async () => ({ success: true as const }),
}))
let hosts = 0
async function section(blocked?: 'off' | 'revoked') {
  await harness.render(createNode(AppGivenSection, { hostKey: `remote:given-${++hosts}`, extensionId: 'searcher', api: api as never, ...(blocked ? { blocked } : {}) }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return harness.container
}

describe('I5 — the 「给了…」 summary says what the runtime does', () => {
  it('switched off here: says no agent gets its tools, not 「given to all agents here」', async () => {
    const root = await section('off')
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).not.toBeNull()
  })

  it('its agent tools taken back: says so', async () => {
    const root = await section('revoked')
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).not.toBeNull()
  })

  it('[control] on and allowed: the summary lists who it is given to', async () => {
    const root = await section()
    expect(root.querySelector('[data-testid="extension-given-blocked"]')).toBeNull()
    expect(root.querySelector('[data-testid="extension-given-searcher"]')).not.toBeNull()
  })
})

it('a refresh that fails over places read before says it failed with a retry; the places stay drawn', async () => {
  const root = await section()
  expect(root.querySelector('[data-testid="extension-given-searcher"]')).not.toBeNull()
  answer.fail = true
  const { appPlaces } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/market-replicas')
  await act(async () => { await appPlaces.refresh(`remote:given-${hosts}`, 'searcher').catch(() => undefined) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(root.querySelector('[role="alert"]')).not.toBeNull()
  expect(root.querySelector('[data-testid="extension-given-searcher"]')).not.toBeNull()
})
