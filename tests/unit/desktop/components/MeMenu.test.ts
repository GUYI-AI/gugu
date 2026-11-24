// @vitest-environment jsdom
// 界面减法 #51: the far-left rail is gone; my avatar at the foot of the sidebar (a MeSlot the session page leaves) opens my
// menu, which holds the rail's places: 联系人, 市场, the dock's Apps, 设置.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeHost } from '../../../../apps/desktop/src/components/me/MeMenu'
import { ME_SLOT_PREFIX } from '../../../../apps/desktop/src/components/me/MeSlot'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { act } from 'react'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

installShellSlots()
const auth = { id: 'u1', email: 'u@e.com', nickname: 'Yang' }
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const slot = document.createElement('div')
document.body.append(slot)

async function renderMe(props: { pendingContactsCount?: number; rail?: boolean } = {}) {
  const onTabChange = vi.fn()
  const harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(MeHost, { onTabChange, pendingContactsCount: props.pendingContactsCount ?? 0 }), { auth })
  await act(async () => readShellSlots()!.setSlot(`${ME_SLOT_PREFIX}test`, slot, props.rail ? 'rail' : 'open'))
  return { harness, onTabChange }
}

afterEach(async () => {
  await act(async () => readShellSlots()!.setSlot(`${ME_SLOT_PREFIX}test`, null))
})

describe('my menu at the foot of the sidebar', () => {
  it('is drawn into the slot: my avatar and, open, my name; on the rail the avatar only', async () => {
    const { harness } = await renderMe()
    try {
      const trigger = slot.querySelector<HTMLElement>('[data-testid="me-menu-trigger"]')!
      expect(trigger.textContent).toContain('Yang')
    } finally {
      harness.cleanup()
    }
    const rail = await renderMe({ rail: true })
    try {
      expect(slot.querySelector('[data-testid="me-menu-trigger"]')!.textContent).not.toContain('Yang')
    } finally {
      rail.harness.cleanup()
    }
  })

  it('holds the rail\'s places: 联系人 and 设置 open their tabs and close the menu', async () => {
    const { harness, onTabChange } = await renderMe()
    try {
      await clickElement(slot.querySelector<HTMLElement>('[data-testid="me-menu-trigger"]')!)
      expect(byTestId('me-menu')).not.toBeNull()
      expect(byTestId(AUTOMATION_TEST_IDS.sidebarAppsNav)).not.toBeNull()
      await clickElement(byTestId(AUTOMATION_TEST_IDS.sidebarContactsNav)!)
      expect(onTabChange).toHaveBeenCalledWith('contacts')
      await clickElement(slot.querySelector<HTMLElement>('[data-testid="me-menu-trigger"]')!)
      await clickElement(byTestId(AUTOMATION_TEST_IDS.sidebarSettingsNav)!)
      expect(onTabChange).toHaveBeenCalledWith('settings')
    } finally {
      harness.cleanup()
    }
  })

  it('a contact request puts a dot on my avatar and on 联系人', async () => {
    const { harness } = await renderMe({ pendingContactsCount: 2 })
    try {
      expect(slot.querySelector('[data-testid="me-menu-trigger"] .gg-sidebar-badge')).not.toBeNull()
      await clickElement(slot.querySelector<HTMLElement>('[data-testid="me-menu-trigger"]')!)
      expect(byTestId(AUTOMATION_TEST_IDS.sidebarContactsNav)!.querySelector('.gg-sidebar-badge')).not.toBeNull()
    } finally {
      harness.cleanup()
    }
  })
})
