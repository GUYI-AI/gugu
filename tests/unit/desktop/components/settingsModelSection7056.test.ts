// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyManager as readModelNotify } from '@tanstack/react-query'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import { clickElement, createNode, createReactHarness, typeInto, waitForCondition } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/sessionpage/SessionSettingsSection', () => ({
  SessionSettingsSection: () => createNode('div', { 'data-testid': 'settings-auxiliary-models' }),
}))

vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    listCustomModels: async () => ({ success: true, data: [] }),
  }),
}))

// #7056 设置「模型」页 = Cursor 的 Settings › Models:列出咕咕提供的全部模型,开关决定哪些出现在模型下拉里;
// 要会员的那些另成一组、不给开关,一处「升级解锁」去网页面板。
const fetchPlatformModelCatalog = vi.fn()
const setPlatformModelHidden = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/agentModelSelection', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/agentModelSelection')>(
    '../../../../apps/desktop/src/lib/agentModelSelection',
  )
  return {
    ...actual,
    fetchPlatformModelCatalog: (...args: unknown[]) => fetchPlatformModelCatalog(...args),
    setPlatformModelHidden: (...args: unknown[]) => setPlatformModelHidden(...args),
  }
})
const openBillingPage = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/appLinks', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/appLinks')>(
    '../../../../apps/desktop/src/lib/appLinks',
  )
  return { ...actual, openBillingPage: () => openBillingPage() }
})

import { ModelSection } from '../../../../apps/desktop/src/components/settings/ModelSection'

const model = (id: string, displayName: string, extra: Partial<{ requiresMembership: boolean; hidden: boolean; enabled: boolean }> = {}) => ({
  id, displayName, protocols: ['anthropic-messages'], enabled: true, requiresMembership: false, hidden: false, ...extra,
})

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { readModelNotify.setScheduler((callback) => { callback() }); queryClient.clear(); followRendererSession('SIGNED_IN', 'user-1');
  harness = createReactHarness()
  fetchPlatformModelCatalog.mockReset().mockResolvedValue([
    model('glm-5.3-flash', 'GLM 5.3 Flash'),
    model('grok-4.5', 'Grok 4.5', { hidden: true }),
    model('claude-opus-5-5', 'Claude Opus 5.5', { requiresMembership: true }),
    model('retired', 'Retired', { enabled: false }),
  ])
  setPlatformModelHidden.mockReset().mockResolvedValue(undefined)
  openBillingPage.mockReset()
})
afterEach(() => { harness.cleanup() })

const switchOf = (modelId: string) =>
  document.querySelector<HTMLElement>(`[data-model-id="${modelId}"] [role="switch"]`)
const loaded = async () => {
  const manage = harness.container.querySelector<HTMLElement>('[data-testid="settings-model-provided-manage"]')!
  await clickElement(manage)
  await waitForCondition(() => switchOf('glm-5.3-flash') !== null, 'model rows did not load')
}

describe('设置「模型」页', () => {
  it('opens the platform catalog dialog from its provider row in Your Models', async () => {
    await harness.render(createNode(ModelSection))
    expect(harness.container.querySelector('[data-testid="settings-auxiliary-models"]')).not.toBeNull()
    const custom = harness.container.querySelector('[data-testid="settings-custom-models"]')!
    expect(custom.querySelector('[data-testid="settings-model-provided-manage"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-model-search"]')).toBeNull()
    expect(switchOf('glm-5.3-flash')).toBeNull()
    await loaded()
    expect(switchOf('glm-5.3-flash')).not.toBeNull()
  })
  it('opens billing from the icon on the Gugu provider row', async () => {
    await harness.render(createNode(ModelSection))
    const findUpgrade = () => harness.container.querySelector<HTMLElement>('[data-testid="settings-model-provided-upgrade"]')
    await waitForCondition(() => !!findUpgrade(), 'upgrade icon did not appear')
    await clickElement(findUpgrade()!)
    expect(openBillingPage).toHaveBeenCalledTimes(1)
  })
  it('lists usable models with switches reflecting what he hid, and members-only ones apart without switches', async () => {
    await harness.render(createNode(ModelSection))
    await loaded()

    const usable = document.querySelector('[data-testid="settings-model-usable"]')!
    expect(usable.textContent).toContain('GLM 5.3 Flash')
    expect(usable.textContent).toContain('Grok 4.5')
    expect(usable.textContent).not.toContain('Claude Opus 5.5')
    // 下架的(enabled=false)哪一组都不列。
    expect(document.body.textContent).not.toContain('Retired')
    expect(switchOf('glm-5.3-flash')!.getAttribute('aria-checked')).toBe('true')
    expect(switchOf('grok-4.5')!.getAttribute('aria-checked')).toBe('false')

    const locked = document.querySelector('[data-testid="settings-model-locked"]')!
    expect(locked.textContent).toContain('Claude Opus 5.5')
    expect(switchOf('claude-opus-5-5')).toBeNull()
    const upgrade = harness.container.querySelector<HTMLElement>('[data-testid="settings-model-provided-upgrade"]')!
    expect(upgrade.textContent).toBe('')
    expect(upgrade.getAttribute('aria-label')).toBe('升级解锁更多模型')
    expect(upgrade.hasAttribute('title')).toBe(false)
  })

  it('saves a switch flip as hidden / shown', async () => {
    await harness.render(createNode(ModelSection))
    await loaded()

    await clickElement(switchOf('glm-5.3-flash')!)
    expect(setPlatformModelHidden).toHaveBeenLastCalledWith('glm-5.3-flash', true)
    expect(switchOf('glm-5.3-flash')!.getAttribute('aria-checked')).toBe('false')

    await clickElement(switchOf('grok-4.5')!)
    expect(setPlatformModelHidden).toHaveBeenLastCalledWith('grok-4.5', false)
  })

  it('flips the switch back and says so when saving fails', async () => {
    setPlatformModelHidden.mockRejectedValue(new Error('boom'))
    await harness.render(createNode(ModelSection))
    await loaded()

    await clickElement(switchOf('glm-5.3-flash')!)
    await waitForCondition(() => switchOf('glm-5.3-flash')!.getAttribute('aria-checked') === 'true', 'switch did not flip back')
    expect(document.body.textContent).toContain('boom')
  })

  it('filters both groups by the search box', async () => {
    await harness.render(createNode(ModelSection))
    await loaded()
    const search = document.querySelector<HTMLInputElement>('[data-testid="settings-model-search"]')!
    await typeInto(search, 'grok')
    await waitForCondition(() => switchOf('glm-5.3-flash') === null, 'search did not filter')
    expect(switchOf('grok-4.5')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-model-locked"]')).toBeNull()

    await typeInto(search, 'nothing-like-this')
    await waitForCondition(() => document.body.textContent?.includes('没有匹配的模型') === true, 'no-match note missing')
  })

  it('has no members-only group for a member', async () => {
    fetchPlatformModelCatalog.mockResolvedValue([model('glm-5.3-flash', 'GLM 5.3 Flash'), model('claude-opus-5-5', 'Claude Opus 5.5')])
    await harness.render(createNode(ModelSection))
    await loaded()
    expect(document.querySelector('[data-testid="settings-model-locked"]')).toBeNull()
    expect(switchOf('claude-opus-5-5')).not.toBeNull()
  })
})
